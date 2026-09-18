/// <reference lib="webworker" />
/**
 * 내보내기 렌더 워커 — Python 사이드카 renderer.py의 브라우저 대체.
 *
 * 매니페스트(cm 좌표·350 DPI)를 OffscreenCanvas 풀해상도 문서로 렌더하고
 * PNG(pHYs 350 DPI 주입) 또는 PSD(평면 RGB 자체 인코더 / 레이어 보존 ag-psd)로
 * 인코딩한다. 회전은 Konva 원점 피벗 규약(translate→rotate→draw) — 캔버스 화면과
 * 동일한 수학이라 WYSIWYG가 보장된다 (renderer.py의 중심 피벗 결함 미계승).
 *
 * Chrome 캔버스 영역 상한(2^28px ≈ 16,384²) 때문에 초대형 문서(100cm×2m 등
 * 380MP)는 할당에 실패할 수 있다 — 이때 친절한 오류로 안내한다.
 */
import { writePsd, type Layer, type Psd } from 'ag-psd'
import { cmToPx, type ExportManifest } from '@workers/exportManifest'
import { rotatedBBox } from '@renderer/components/canvas/alignment'
import { encodeFlattenedPsd, patchPsdResolution } from './psdFlat'
import { injectPngDpi } from './pngMeta'
import { encodePdf } from './pdfFlat'

interface ExportRequest {
  type: 'export'
  manifest: ExportManifest
  files: Array<{ path: string; blob: Blob }>
}

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

const post = (message: WorkerMessage, transfer?: Transferable[]): void => {
  if (transfer) self.postMessage(message, transfer)
  else self.postMessage(message)
}

const fileNameOf = (path: string): string => {
  const seg = path.split(/[\\/]/).pop() ?? path
  return seg.replace(/\.[^.]+$/, '') || 'layer'
}

function renderScene(
  manifest: ExportManifest,
  bitmaps: Map<string, ImageBitmap>
): {
  canvas: OffscreenCanvas
  ctx: OffscreenCanvasRenderingContext2D
  widthPx: number
  heightPx: number
} {
  const widthPx = cmToPx(manifest.canvas.width_cm, manifest.canvas.dpi)
  const heightPx = cmToPx(manifest.canvas.height_m * 100, manifest.canvas.dpi)
  const canvas = new OffscreenCanvas(widthPx, heightPx)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('오프스크린 2D 컨텍스트 생성 실패')
  if (canvas.width === 0 || canvas.height === 0) {
    throw new Error(
      `문서 캔버스를 할당하지 못했습니다 (${widthPx}×${heightPx}px). 브라우저 메모리·캔버스 상한 초과로 보입니다 — 문서 크기를 줄여 주세요.`
    )
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  for (const [index, item] of manifest.items.entries()) {
    const bitmap = bitmaps.get(item.src)
    if (!bitmap) continue
    ctx.save()
    ctx.translate(cmToPx(item.x_cm, manifest.canvas.dpi), cmToPx(item.y_cm, manifest.canvas.dpi))
    ctx.rotate((item.rotation * Math.PI) / 180)
    ctx.drawImage(
      bitmap,
      0,
      0,
      cmToPx(item.width_cm, manifest.canvas.dpi),
      cmToPx(item.height_cm, manifest.canvas.dpi)
    )
    ctx.restore()
    post({ type: 'progress', stage: 'items', current: index + 1, total: manifest.items.length })
  }
  return { canvas, ctx, widthPx, heightPx }
}

async function encodePng(canvas: OffscreenCanvas, dpi: number): Promise<Blob> {
  const raw = await canvas.convertToBlob({ type: 'image/png' })
  return new Blob([injectPngDpi(await raw.arrayBuffer(), dpi)], { type: 'image/png' })
}

/** 검수용 PDF — 투명 픽셀을 흰 배경으로 합성 후 JPEG(DCT)로 페이지에 임베드 */
async function encodeScenePdf(
  scene: {
    canvas: OffscreenCanvas
    ctx: OffscreenCanvasRenderingContext2D
    widthPx: number
    heightPx: number
  },
  dpi: number
): Promise<Blob> {
  scene.ctx.globalCompositeOperation = 'destination-over'
  scene.ctx.fillStyle = '#ffffff'
  scene.ctx.fillRect(0, 0, scene.widthPx, scene.heightPx)
  scene.ctx.globalCompositeOperation = 'source-over'
  const jpeg = await scene.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  return encodePdf({
    widthPx: scene.widthPx,
    heightPx: scene.heightPx,
    dpi,
    jpeg: new Uint8Array(await jpeg.arrayBuffer())
  })
}

function itemLayerImageData(
  item: ExportManifest['items'][number],
  bitmap: ImageBitmap,
  dpi: number
): { left: number; top: number; imageData: ImageData; name: string } {
  const x = cmToPx(item.x_cm, dpi)
  const y = cmToPx(item.y_cm, dpi)
  const w = cmToPx(item.width_cm, dpi)
  const h = cmToPx(item.height_cm, dpi)
  const box = rotatedBBox({ id: item.src, x, y, widthPx: w, heightPx: h, rotation: item.rotation })
  const boxW = Math.max(1, Math.round(box.right - box.left))
  const boxH = Math.max(1, Math.round(box.bottom - box.top))
  const canvas = new OffscreenCanvas(boxW, boxH)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('레이어 오프스크린 컨텍스트 생성 실패')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.translate(x - Math.round(box.left), y - Math.round(box.top))
  ctx.rotate((item.rotation * Math.PI) / 180)
  ctx.drawImage(bitmap, 0, 0, w, h)
  return {
    left: Math.round(box.left),
    top: Math.round(box.top),
    imageData: ctx.getImageData(0, 0, boxW, boxH),
    name: fileNameOf(item.src)
  }
}

async function encodeLayeredPsd(
  manifest: ExportManifest,
  bitmaps: Map<string, ImageBitmap>,
  scene: {
    canvas: OffscreenCanvas
    ctx: OffscreenCanvasRenderingContext2D
    widthPx: number
    heightPx: number
  }
): Promise<Blob> {
  const dpi = manifest.canvas.dpi
  const children: Layer[] = manifest.items.map((item) => {
    const bitmap = bitmaps.get(item.src)
    if (!bitmap) throw new Error(`원본 누락: ${item.src}`)
    const rendered = itemLayerImageData(item, bitmap, dpi)
    const layer: Layer = {
      name: rendered.name,
      left: rendered.left,
      top: rendered.top,
      imageData: rendered.imageData
    }
    return layer
  })
  const psd: Psd = {
    width: scene.widthPx,
    height: scene.heightPx,
    channels: 3,
    children,
    imageData: scene.ctx.getImageData(0, 0, scene.widthPx, scene.heightPx)
  }
  const buffer = writePsd(psd, { generateThumbnail: false })
  return new Blob([patchPsdResolution(buffer, dpi)], { type: 'image/vnd.adobe.photoshop' })
}

async function handleExport(request: ExportRequest): Promise<void> {
  const started = performance.now()
  const bitmaps = new Map<string, ImageBitmap>()
  try {
    for (const file of request.files) {
      if (!bitmaps.has(file.path)) bitmaps.set(file.path, await createImageBitmap(file.blob))
    }
    const scene = renderScene(request.manifest, bitmaps)
    post({ type: 'progress', stage: 'write', current: 1, total: 1 })

    const format = request.manifest.format ?? 'psd'
    const dpi = request.manifest.canvas.dpi
    let blob: Blob
    let layerCount = 1
    if (format === 'png') {
      blob = await encodePng(scene.canvas, dpi)
    } else if (format === 'pdf') {
      blob = await encodeScenePdf(scene, dpi)
    } else if (request.manifest.flatten !== false) {
      blob = encodeFlattenedPsd({
        width: scene.widthPx,
        height: scene.heightPx,
        dpi,
        read: (y, h) => scene.ctx.getImageData(0, y, scene.widthPx, h)
      })
    } else {
      blob = await encodeLayeredPsd(request.manifest, bitmaps, scene)
      layerCount = request.manifest.items.length
    }
    post({
      type: 'done',
      blob,
      widthPx: scene.widthPx,
      heightPx: scene.heightPx,
      layerCount,
      durationMs: Math.round(performance.now() - started)
    })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  } finally {
    for (const bitmap of bitmaps.values()) bitmap.close()
  }
}

self.addEventListener('message', (event: MessageEvent<ExportRequest>) => {
  const data = event.data
  if (data?.type === 'export') void handleExport(data)
})
