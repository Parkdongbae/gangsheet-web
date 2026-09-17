/**
 * 브라우저 이미지 처리 — Python 사이드카(rembg·auto_trim·upscale·Pillow) 대체.
 *
 * - 임포트: Blob → 치수/DPI 메타/≤2,048px PNG 프리뷰(데스크톱 메인 프로세스 규격)
 * - 배경 제거: 테두리 추정 단색 배경 플러드필 + 가장자리 디프린지 (rembg AI 대체 —
 *   정밀 누끼는 BgSitesDialog 외부 사이트 병행 권장)
 * - Auto-Trim: 알파 바운딩 박스 크롭 (autotrim.py와 동일 임계값)
 * - 업스케일: 공유 Plan Builder(core/upscaler/plan) 체인대로 고품질 단계별 리샘플
 * - PSD 읽기: ag-psd composite 뷰 (데스크톱과 동일한 읽기 전용 지원)
 */
import { readPsd } from 'ag-psd'
import { AUTO_TRIM_ALPHA_THRESHOLD } from '@core/autoTrim'
import { extractImageDpi } from '@core/imageMeta'
import {
  buildUpscalePlan,
  cumulativeSquareWeights,
  overallProgress,
  type UpscalePlan
} from '@core/upscaler/plan'
import type { UpscaleOptions, UpscaleProgress } from '@shared/ipc'
import { injectPngDpi } from './pngMeta'

export const PREVIEW_MAX_PX = 2048

export function decodeToCanvas(
  bitmap: CanvasImageSource,
  width: number,
  height: number
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D 컨텍스트를 생성할 수 없습니다')
  ctx.drawImage(bitmap, 0, 0)
  return { canvas, ctx }
}

export async function decodeBlob(
  blob: Blob
): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  if (blob.size >= 4) {
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
    if (head[0] === 0x38 && head[1] === 0x42 && head[2] === 0x50 && head[3] === 0x53) {
      const psd = readPsd(await blob.arrayBuffer())
      if (!psd.canvas || psd.width <= 0 || psd.height <= 0)
        throw new Error('PSD 합성 이미지를 읽을 수 없습니다')
      return { source: psd.canvas, width: psd.width, height: psd.height }
    }
  }
  try {
    const bitmap = await createImageBitmap(blob)
    return { source: bitmap, width: bitmap.width, height: bitmap.height }
  } catch {
    throw new Error('이 이미지 형식은 브라우저에서 디코딩할 수 없습니다')
  }
}

export interface DecodedImage {
  canvas: HTMLCanvasElement
  width: number
  height: number
}

export async function decodeFull(blob: Blob): Promise<DecodedImage> {
  const { source, width, height } = await decodeBlob(blob)
  const { canvas } = decodeToCanvas(source, width, height)
  if (source instanceof ImageBitmap) source.close()
  return { canvas, width, height }
}

/** 원본 헤더 → 물리 DPI (PNG pHYs / JPEG JFIF) */
export async function readDpiMeta(blob: Blob): Promise<number | undefined> {
  try {
    const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer())
    const dpi = extractImageDpi(head)
    return dpi ?? undefined
  } catch {
    return undefined
  }
}

/** ≤2,048px PNG dataUrl 프리뷰 — 데스크톱 importImage 규격과 동일 */
export function makePreview(
  source: CanvasImageSource,
  width: number,
  height: number
): { dataUrl: string; previewWidthPx: number; previewHeightPx: number } {
  const scale = Math.min(1, PREVIEW_MAX_PX / Math.max(width, height))
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D 컨텍스트를 생성할 수 없습니다')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, w, h)
  return { dataUrl: canvas.toDataURL('image/png'), previewWidthPx: w, previewHeightPx: h }
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = 'image/png',
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('이미지 인코딩 실패'))),
      type,
      quality
    )
  })
}

// ---- 배경 제거 (단색 플러드필) ----

const BG_TOLERANCE_SQ = 32 * 32
/** 디프린지 — 제거 경계 1px 링의 알파를 60%로 눌러 밝은 테두리 잔상 제거 */
const DEFRINGE_ALPHA_FACTOR = 0.6

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function estimateBorderColor(
  data: Uint8ClampedArray,
  width: number,
  height: number
): [number, number, number] | null {
  const channels: [number[], number[], number[]] = [[], [], []]
  const collect = (x: number, y: number): void => {
    const i = (y * width + x) * 4
    if (data[i + 3]! >= 128) {
      channels[0].push(data[i]!)
      channels[1].push(data[i + 1]!)
      channels[2].push(data[i + 2]!)
    }
  }
  const stepX = Math.max(1, Math.floor(width / 256))
  const stepY = Math.max(1, Math.floor(height / 256))
  for (let x = 0; x < width; x += stepX) {
    collect(x, 0)
    collect(x, height - 1)
  }
  for (let y = 0; y < height; y += stepY) {
    collect(0, y)
    collect(width - 1, y)
  }
  if (channels[0].length === 0) return null
  return [median(channels[0]), median(channels[1]), median(channels[2])]
}

/**
 * 단색(주로 흰색) 배경 제거 — 테두리와 연결된 유사색 영역을 투명화한다.
 * 테두리가 이미 완전 투명한 원본은 배경이 없는 것으로 보고 원본 그대로 반환.
 */
export async function removeSolidBackground(blob: Blob): Promise<Blob> {
  const { canvas, width, height } = await decodeFull(blob)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D 컨텍스트를 생성할 수 없습니다')
  const image = ctx.getImageData(0, 0, width, height)
  const data = image.data
  const bg = estimateBorderColor(data, width, height)
  if (!bg) return blob

  const matches = (i: number): boolean => {
    if (data[i + 3]! < 16) return true
    const dr = data[i]! - bg[0]
    const dg = data[i + 1]! - bg[1]
    const db = data[i + 2]! - bg[2]
    return dr * dr + dg * dg + db * db <= BG_TOLERANCE_SQ
  }

  const pixelCount = width * height
  const removed = new Uint8Array(pixelCount)
  const stack = new Int32Array(pixelCount)
  let top = 0
  const seed = (p: number): void => {
    if (removed[p] === 1) return
    if (!matches(p * 4)) return
    removed[p] = 1
    stack[top++] = p
  }
  for (let x = 0; x < width; x++) {
    seed(x)
    seed((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    seed(y * width)
    seed(y * width + width - 1)
  }

  while (top > 0) {
    const p = stack[--top]!
    const x = p % width
    if (x > 0) seed(p - 1)
    if (x < width - 1) seed(p + 1)
    if (p >= width) seed(p - width)
    if (p < pixelCount - width) seed(p + width)
  }

  let changed = false
  for (let p = 0; p < pixelCount; p++) {
    if (removed[p]) {
      data[p * 4 + 3] = 0
      changed = true
    }
  }
  if (!changed) return blob

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (removed[p]) continue
      const neighborRemoved =
        (x > 0 && removed[p - 1] === 1) ||
        (x < width - 1 && removed[p + 1] === 1) ||
        (y > 0 && removed[p - width] === 1) ||
        (y < height - 1 && removed[p + width] === 1)
      if (neighborRemoved) {
        const i = p * 4
        data[i + 3] = Math.round(data[i + 3]! * DEFRINGE_ALPHA_FACTOR)
      }
    }
  }

  ctx.putImageData(image, 0, 0)
  return canvasToBlob(canvas)
}

// ---- Auto-Trim ----

export interface TrimResult {
  blob: Blob
  trimmed: boolean
  width: number
  height: number
}

/** 알파 바운딩 박스로 투명 여백 제거 — 임계값은 autotrim.py와 동일(>10) */
export async function autoTrimBlob(blob: Blob): Promise<TrimResult> {
  const { canvas, width, height } = await decodeFull(blob)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D 컨텍스트를 생성할 수 없습니다')
  const data = ctx.getImageData(0, 0, width, height).data

  let hasAlpha = false
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3]!
      if (alpha < 255) hasAlpha = true
      if (alpha > AUTO_TRIM_ALPHA_THRESHOLD) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (!hasAlpha || maxX < 0 || maxX >= width || maxY >= height) {
    return { blob, trimmed: false, width, height }
  }
  if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) {
    return { blob, trimmed: false, width, height }
  }
  const cropW = maxX - minX + 1
  const cropH = maxY - minY + 1
  const cropped = document.createElement('canvas')
  cropped.width = cropW
  cropped.height = cropH
  const cropCtx = cropped.getContext('2d')
  if (!cropCtx) throw new Error('2D 컨텍스트를 생성할 수 없습니다')
  cropCtx.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH)
  return { blob: await canvasToBlob(cropped), trimmed: true, width: cropW, height: cropH }
}

// ---- 업스케일 (단계별 고품질 리샘플) ----

export interface UpscaleRunResult {
  blob: Blob
  width: number
  height: number
  totalScale: number
  steps: Array<{ step: number; scale: number; outW: number; outH: number; ms: number }>
  plan: UpscalePlan
}

function drawScaled(
  source: HTMLCanvasElement,
  targetW: number,
  targetH: number,
  letterbox: boolean
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, targetW)
  canvas.height = Math.max(1, targetH)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D 컨텍스트를 생성할 수 없습니다')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  if (letterbox) {
    const scale = Math.min(canvas.width / source.width, canvas.height / source.height)
    const w = source.width * scale
    const h = source.height * scale
    ctx.drawImage(source, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
  } else {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  }
  return canvas
}

/**
 * 공유 Plan Builder가 산출한 체인(2배씩 등)대로 단계별 리샘플 업스케일.
 * AI 초해상화(RealESRGAN)가 아니므로 새 디테일은 생성되지 않는다 —
 * 웹 버전 차이는 web/README.md와 다이얼로그 안내로 명시.
 */
export async function runUpscale(
  blob: Blob,
  options: UpscaleOptions,
  onProgress: (p: UpscaleProgress) => void
): Promise<UpscaleRunResult> {
  const decoded = await decodeFull(blob)
  const srcW = decoded.width
  const srcH = decoded.height
  const plan = buildUpscalePlan(
    {
      unit: options.unit,
      widthCm: options.widthCm,
      heightCm: options.heightCm,
      widthPx: options.widthPx,
      heightPx: options.heightPx,
      scale: options.scale,
      dpi: options.dpi,
      strategy: options.stepStrategy,
      fitMode: options.fitMode
    },
    { width: srcW, height: srcH }
  )

  let current = decoded.canvas
  if (plan.srcCrop) {
    const { x, y, width, height } = plan.srcCrop
    const cropped = document.createElement('canvas')
    cropped.width = width
    cropped.height = height
    const ctx = cropped.getContext('2d')
    if (!ctx) throw new Error('2D 컨텍스트를 생성할 수 없습니다')
    ctx.drawImage(current, x, y, width, height, 0, 0, width, height)
    current = cropped
  }

  const weights = cumulativeSquareWeights(plan.chain)
  const steps: UpscaleRunResult['steps'] = []
  for (const [index, scale] of plan.chain.entries()) {
    const started = performance.now()
    const outW = Math.max(1, Math.round(current.width * scale))
    const outH = Math.max(1, Math.round(current.height * scale))
    current = drawScaled(current, outW, outH, false)
    steps.push({ step: index + 1, scale, outW, outH, ms: Math.round(performance.now() - started) })
    onProgress({
      stage: 'step',
      step: index + 1,
      totalSteps: plan.chain.length,
      current: index + 1,
      total: plan.chain.length,
      overallProgress: overallProgress(weights, index + 1, 1)
    })
  }

  if (current.width !== plan.target.width || current.height !== plan.target.height) {
    current = drawScaled(
      current,
      plan.target.width,
      plan.target.height,
      options.fitMode === 'CONTAIN'
    )
  }

  const mime =
    options.format === 'png' ? 'image/png' : options.format === 'jpeg' ? 'image/jpeg' : 'image/webp'
  let outBlob = await canvasToBlob(current, mime, options.quality)
  if (options.format === 'png' && options.embedDpiMetadata) {
    outBlob = new Blob([injectPngDpi(await outBlob.arrayBuffer(), options.dpi)], {
      type: 'image/png'
    })
  }

  return {
    blob: outBlob,
    width: current.width,
    height: current.height,
    totalScale: plan.totalScale,
    steps,
    plan
  }
}
