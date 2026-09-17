/**
 * 프로젝트 파일(.dtf) IPC — 저장·불러오기 다이얼로그 + 파일 입출력.
 * 경로 계약만 오가며(STDIO_GUIDE와 동일 철학) 프리뷰 dataUrl은 저장하지 않는다 —
 * 로드 시 원본 filePath에서 재생성한다(projectIO.ts).
 * pathOverride는 E2E 자동검증용 선택 인자(DTF_SMOKE_TEST 패턴) — 지정 시 다이얼로그 없이 직접 입출력.
 */
import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_EXTENSION, validateProjectData, type ProjectData } from '../../core/project'
import { readLastDir, saveDefaultPath, saveLastDir } from './dialogMemory'

const filters: Electron.FileFilter[] = [
  { name: 'DTF 갱시트 프로젝트', extensions: [PROJECT_EXTENSION] }
]

const withExtension = (path: string): string =>
  path.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`) ? path : `${path}.${PROJECT_EXTENSION}`

/** 마지막 프로젝트 폴더 기준 저장 경로 선택 — 확정 시 폴더를 기억한다 */
async function pickSavePath(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const result = await dialog.showSaveDialog(win, {
    title: '프로젝트 저장',
    defaultPath: saveDefaultPath('project', `갭시트.${PROJECT_EXTENSION}`),
    filters
  })
  if (result.canceled || !result.filePath) return null
  saveLastDir('project', result.filePath)
  return result.filePath
}

/** 마지막 프로젝트 폴더에서 열기 — 확정 시 폴더를 기억한다 */
async function pickOpenPath(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: '프로젝트 열기',
    defaultPath: readLastDir('project'),
    filters,
    properties: ['openFile']
  })
  const picked = result.canceled ? null : (result.filePaths[0] ?? null)
  if (picked) saveLastDir('project', picked)
  return picked
}

export interface OpenedProject {
  data: ProjectData
  /** 열린 파일 절대 경로 — 문서 이름 표시·재저장 기본 경로 힌트 */
  filePath: string
}

/** 웹 빌드가 저장한 내장 에셋(.dtf assets)을 디스크 파일로 구체화해 경로 재매핑 —
 *  userData/embedded-assets/<소스 해시>에 기록(같은 파일 재오픈 시 덮어쓰기)하므로
 *  프리뷰 재생성·사이드카 내보내기 등 기존 파일 경로 파이프라인이 무수정 동작한다. */
function materializeEmbeddedAssets(data: ProjectData, source: string): ProjectData {
  if (!data.assets || data.assets.length === 0) return data
  const dir = join(
    app.getPath('userData'),
    'embedded-assets',
    createHash('md5').update(source).digest('hex')
  )
  mkdirSync(dir, { recursive: true })
  const remap = new Map<string, string>()
  data.assets.forEach((asset, index) => {
    const safeName =
      asset.name
        .split('')
        .filter((ch) => ch.charCodeAt(0) >= 0x20)
        .join('')
        .replace(/[\\/:*?"<>|]/g, '_') || `asset-${index}`
    const target = join(dir, `${index}-${safeName}`)
    writeFileSync(target, Buffer.from(asset.dataBase64, 'base64'))
    remap.set(asset.path, target)
  })
  const materialized: ProjectData = {
    ...data,
    images: data.images.map((image) => {
      const target = remap.get(image.filePath)
      return target ? { ...image, filePath: target } : image
    })
  }
  delete materialized.assets
  return materialized
}

export function registerProjectIpc(): void {
  ipcMain.handle(
    'project:save',
    async (_event, data: unknown, pathOverride?: unknown): Promise<string | null> => {
      // 저장 직전 자체 검증 — 손상 파일 생성 차단 (렌더러 상태를 신뢰하지 않는다)
      const project = validateProjectData(data)
      const picked =
        typeof pathOverride === 'string' && pathOverride.length > 0
          ? pathOverride
          : await pickSavePath()
      if (!picked) return null
      const target = withExtension(picked)
      writeFileSync(target, JSON.stringify(project, null, 2), 'utf-8')
      return target
    }
  )

  ipcMain.handle(
    'project:open',
    async (_event, pathOverride?: unknown): Promise<OpenedProject | null> => {
      const source =
        typeof pathOverride === 'string' && pathOverride.length > 0
          ? pathOverride
          : await pickOpenPath()
      if (!source) return null
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(source, 'utf-8'))
      } catch {
        throw new Error('프로젝트 파일을 해석할 수 없습니다 — 손상되었거나 DTF 프로젝트가 아닙니다')
      }
      return { data: materializeEmbeddedAssets(validateProjectData(raw), source), filePath: source }
    }
  )
}
