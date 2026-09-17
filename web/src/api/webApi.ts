/**
 * DtfApi 브라우저 구현 — Electron preload(window.api)를 대체하는 웹 어댑터.
 *
 * 계약(src/types/ipc.ts DtfApi)을 그대로 만족하므로 렌더러(App·ProxyCanvas·
 * ExportDialog·UpscaleDialog)는 수정 없이 재사용된다. OS 의존 기능의 대체:
 *   파일 대화상자 → File System Access API + input[type=file] 폴백 (fsAccess.ts)
 *   디스크 원본 보관 → 가상 파일 시스템 + IndexedDB (vfs.ts)
 *   사이드카 렌더·배경제거·트림·업스케일 → Canvas/Worker 파이프라인 (imageOps·exportWorker)
 */
import type {
  DtfApi,
  ExportFormat,
  ExportProgress,
  ExportResult,
  ImageInfo,
  ImportedImage,
  OpenedProject,
  RemoveBgImage,
  TrimmedImage,
  UpscaleOptions,
  UpscaleProgress,
  UpscaledImage
} from '@shared/ipc'
import { validateProjectData, type ProjectData } from '@core/project'
import type { ExportManifest } from '@workers/exportManifest'
import * as fsa from './fsAccess'
import * as ops from './imageOps'
import {
  kvGet,
  kvSet,
  loadPersisted,
  registerBlob,
  registerFile,
  requireBlob,
  vfsFileName
} from './vfs'

const AUTOSAVE_KEY = 'autosave-project'
const AUTOSAVE_PATH = 'web-autosave://last'
const UPSCALE_CANCELLED = '업스케일이 취소되었습니다'
const EXPORT_CANCELLED = '내보내기가 취소되었습니다'

let vfsReady: Promise<number> | null = null
const ensureVfs = (): Promise<number> => (vfsReady ??= loadPersisted())

let cancelledUpscale = false

function makeListenerBus<T>(): {
  emit: (value: T) => void
  subscribe: (listener: (value: T) => void) => () => void
} {
  const listeners = new Set<(value: T) => void>()
  return {
    emit: (value) => {
      for (const listener of listeners) listener(value)
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

const exportBus = makeListenerBus<ExportProgress>()
const upscaleBus = makeListenerBus<UpscaleProgress>()

type WorkerMessage =
  | { type: 'progress'; stage: 'items' | 'write'; current: number; total: number }
  | {
      type: 'done'
      blob: Blob
      widthPx: number
      heightPx: number
      layerCount: number
      durationMs: number
    }
  | { type: 'error'; message: string }

let exportWorker: Worker | null = null
let exportReject: ((err: Error) => void) | null = null
let lastExportTarget: fsa.SaveTarget | null = null
let lastSaveTarget: fsa.SaveTarget | null = null

function rejectExport(message: string): void {
  const reject = exportReject
  exportReject = null
  if (reject) reject(new Error(message))
}

async function runExport(manifest: ExportManifest): Promise<ExportResult> {
  await ensureVfs()
  const paths = [...new Set(manifest.items.map((item) => item.src))]
  const files: Array<{ path: string; blob: Blob }> = []
  for (const path of paths) {
    try {
      files.push({ path, blob: requireBlob(path) })
    } catch (err) {
      throw new Error(
        `원본을 찾을 수 없습니다: ${vfsFileName(path)} (${err instanceof Error ? err.message : ''})`
      )
    }
  }

  exportWorker?.terminate()
  const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' })
  exportWorker = worker
  const started = performance.now()

  return new Promise<ExportResult>((resolve, reject) => {
    exportReject = reject
    worker.onmessage = (event: MessageEvent<WorkerMessage>): void => {
      const data = event.data
      if (data.type === 'progress') {
        exportBus.emit({ stage: data.stage, current: data.current, total: data.total })
        return
      }
      if (data.type === 'done') {
        exportReject = null
        void (async (): Promise<void> => {
          try {
            await writeExportBlob(data.blob, manifest)
            resolve({
              output_path:
                lastExportTarget?.mode === 'handle'
                  ? lastExportTarget.name
                  : `다운로드/${manifest.output_path}`,
              width_px: data.widthPx,
              height_px: data.heightPx,
              layer_count: data.layerCount,
              duration_ms: Math.round(performance.now() - started)
            })
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })()
        return
      }
      if (data.type === 'error') rejectExport(data.message)
    }
    worker.onerror = (): void => rejectExport('내보내기 워커 오류')
    worker.postMessage({ type: 'export', manifest, files })
  })
}

async function writeExportBlob(blob: Blob, manifest: ExportManifest): Promise<void> {
  const target = lastExportTarget
  if (target?.mode === 'handle') {
    await fsa.writeToHandle(target.handle, blob)
    return
  }
  fsa.downloadBlob(blob, manifest.output_path)
}

async function buildImported(blob: Blob): Promise<ImportedImage> {
  const { source, width, height } = await ops.decodeBlob(blob)
  const dpi = await ops.readDpiMeta(blob)
  const preview = ops.makePreview(source, width, height)
  if (source instanceof ImageBitmap) source.close()
  return {
    dataUrl: preview.dataUrl,
    widthPx: width,
    heightPx: height,
    previewWidthPx: preview.previewWidthPx,
    previewHeightPx: preview.previewHeightPx,
    ...(dpi !== undefined ? { dpi } : {})
  }
}

const stripExt = (name: string): string => name.replace(/\.[^.]+$/, '')

function stamp(): string {
  const d = new Date()
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`
}

function openBundledDocument(file: string): Promise<void> {
  const win = window.open(file, '_blank', 'noopener')
  if (!win) alert('팝업이 차단되어 문서를 열 수 없습니다. 팝업 허용 후 다시 시도해 주세요.')
  return Promise.resolve()
}

const fileByPath = new WeakMap<File, string>()

function createWebApi(): DtfApi {
  const api: DtfApi = {
    async openImages(): Promise<string[] | null> {
      const files = await fsa.pickOpenFiles('open-images', [
        { description: '이미지', accept: { 'image/*': fsa.IMAGE_EXTENSIONS } }
      ])
      if (!files || files.length === 0) return null
      return files.map((file) => registerFile(file))
    },

    async importImage(filePath: string): Promise<ImportedImage> {
      await ensureVfs()
      return buildImported(requireBlob(filePath))
    },

    async removeBackground(filePath: string): Promise<RemoveBgImage> {
      await ensureVfs()
      const result = await ops.removeSolidBackground(requireBlob(filePath))
      const newPath = registerBlob(`${stripExt(vfsFileName(filePath))}_nobg.png`, result)
      return { ...(await buildImported(result)), filePath: newPath }
    },

    async autoTrimImage(filePath: string): Promise<TrimmedImage> {
      await ensureVfs()
      const blob = requireBlob(filePath)
      const result = await ops.autoTrimBlob(blob)
      if (!result.trimmed) {
        return { ...(await buildImported(blob)), filePath, trimmed: false }
      }
      const newPath = registerBlob(`${stripExt(vfsFileName(filePath))}_trim.png`, result.blob)
      return { ...(await buildImported(result.blob)), filePath: newPath, trimmed: true }
    },

    async imageInfo(filePath: string): Promise<ImageInfo> {
      await ensureVfs()
      const blob = requireBlob(filePath)
      const { width, height } = await ops.decodeBlob(blob)
      const dpi = await ops.readDpiMeta(blob)
      return { width, height, bytes: blob.size, ...(dpi !== undefined ? { dpi } : {}) }
    },

    async upscaleImage(filePath: string, options: UpscaleOptions): Promise<UpscaledImage> {
      await ensureVfs()
      cancelledUpscale = false
      const blob = requireBlob(filePath)
      const run = await ops.runUpscale(blob, options, (progress) => {
        if (cancelledUpscale) throw new Error(UPSCALE_CANCELLED)
        upscaleBus.emit(progress)
      })
      const ext = options.format === 'jpeg' ? 'jpg' : options.format
      const newPath = registerBlob(`${stripExt(vfsFileName(filePath))}_up.${ext}`, run.blob)
      return {
        ...(await buildImported(run.blob)),
        ...(options.embedDpiMetadata !== false ? { dpi: options.dpi } : {}),
        filePath: newPath,
        totalScale: run.totalScale,
        steps: run.steps,
        elapsedMs: run.steps.reduce((sum, step) => sum + step.ms, 0)
      }
    },

    async resumeUpscale(): Promise<UpscaledImage> {
      throw new Error(
        '웹 버전은 업스케일 이어하기를 지원하지 않습니다. 처음부터 다시 시도해 주세요.'
      )
    },

    async getUpscaleResumable(): Promise<null> {
      return null
    },

    async getUpscaleCalibration(): Promise<{ msPerMpx: number | null }> {
      return { msPerMpx: null }
    },

    async cancelUpscale(): Promise<void> {
      cancelledUpscale = true
    },

    onUpscaleProgress(listener: (progress: UpscaleProgress) => void): () => void {
      return upscaleBus.subscribe(listener)
    },

    getPathForFile(file: File): string {
      const known = fileByPath.get(file)
      if (known) return known
      const path = registerFile(file)
      fileByPath.set(file, path)
      return path
    },

    async exportSaveDialog(format: ExportFormat): Promise<string | null> {
      const target = await fsa.pickSaveFile(
        `gangsheet-${stamp()}.${format}`,
        fsa.acceptExtensionsFor(format)
      )
      if (!target) return null
      lastExportTarget = target
      return target.name
    },

    async exportDocument(manifest: ExportManifest): Promise<ExportResult> {
      return runExport(manifest)
    },

    async cancelExport(): Promise<void> {
      exportWorker?.terminate()
      exportWorker = null
      rejectExport(EXPORT_CANCELLED)
    },

    onExportProgress(listener: (progress: ExportProgress) => void): () => void {
      return exportBus.subscribe(listener)
    },

    openGuidePdf: (): Promise<void> => openBundledDocument('./photoshop_cloud_guide.pdf'),
    openManualPdf: (): Promise<void> => openBundledDocument('./DTF_사용자_메뉴얼.pdf'),
    openLicenses: (): Promise<void> => openBundledDocument('./THIRD_PARTY_LICENSES.txt'),
    openBgGuide: (): Promise<void> =>
      openBundledDocument('./adobe_express_background_removal_guide.pdf'),

    async saveProject(data: ProjectData, path?: string): Promise<string | null> {
      const normalized = validateProjectData(data)
      await kvSet(AUTOSAVE_KEY, { data: normalized, savedAt: Date.now() })

      if (path === AUTOSAVE_PATH) return AUTOSAVE_PATH

      const blob = new Blob([JSON.stringify(normalized, null, 2)], { type: 'application/json' })
      if (path !== undefined) {
        const name = /\.dtf$/i.test(path) ? path : `${path}.dtf`
        fsa.downloadBlob(blob, name.split(/[\\/]/).pop() ?? 'project.dtf')
        return name
      }
      const suggested = lastSaveTarget?.name ?? 'gangsheet.dtf'
      const target = await fsa.pickSaveFile(suggested, [
        { description: 'DTF 프로젝트', accept: { 'application/json': ['.dtf'] } }
      ])
      if (!target) return null
      lastSaveTarget = target
      if (target.mode === 'handle') await fsa.writeToHandle(target.handle, blob)
      else fsa.downloadBlob(blob, target.name)
      return target.name
    },

    async openProject(path?: string): Promise<OpenedProject | null> {
      await ensureVfs()
      if (path === AUTOSAVE_PATH) {
        const saved = await kvGet<{ data: ProjectData; savedAt: number }>(AUTOSAVE_KEY)
        if (!saved?.data) throw new Error('자동 저장된 작업이 없습니다')
        return { data: validateProjectData(saved.data), filePath: '자동 저장 문서' }
      }
      if (path !== undefined) {
        throw new Error('경로 직접 열기는 웹 버전에서 지원되지 않습니다')
      }
      const file = await fsa.pickOpenFile('open-project', [
        { description: 'DTF 프로젝트', accept: { 'application/json': ['.dtf'] } }
      ])
      if (!file) return null
      return { data: validateProjectData(JSON.parse(await file.text())), filePath: file.name }
    },

    exportColorMode: 'RGB',
    aiUpscale: false
  }
  return api
}

export function installWebApi(): void {
  window.api = createWebApi()
}
