/**
 * 브라우저 이미지 처리 — Python 사이드카(rembg·auto_trim·upscale·Pillow) 대체.
 *
 * - 임포트: Blob → 치수/DPI 메타/≤2,048px PNG 프리뷰(데스크톱 메인 프로세스 규격)
 * - 배경 제거: 브라우저 내 AI(ISNet·onnxruntime-web, bgRemoval/) + 단색 배경 플러드필 모드
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
import type { RemoveBgProgress, UpscaleOptions, UpscaleProgress } from '@shared/ipc'
import { removeBackgroundAi } from './bgRemoval/bgClient'
import { removeSolidBackgroundPixels } from './bgRemoval/matting'
import { AI_UPSCALE_CANCELLED, upscaleWithAi } from './upscale/upClient'
import { planPasses } from './upscale/tiles'
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

// ---- 배경 제거 ----

/**
 * 단색 배경 제거 — 테두리와 연결된 유사색 영역을 투명화하고 경계를 다듬는다
 * (픽셀 연산은 bgRemoval/matting.ts). 배경이 없으면 원본 그대로 반환.
 */
export async function removeSolidBackground(blob: Blob): Promise<Blob> {
  const { canvas, width, height } = await decodeFull(blob)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D 컨텍스트를 생성할 수 없습니다')
  const image = ctx.getImageData(0, 0, width, height)
  if (!removeSolidBackgroundPixels(image.data, width, height)) return blob
  ctx.putImageData(image, 0, 0)
  return canvasToBlob(canvas)
}

/** AI 배경 제거 — 워커에서 ISNet 추론 후 원본 해상도 RGBA PNG 반환 */
export async function removeBackgroundWithAi(
  blob: Blob,
  onProgress: (progress: RemoveBgProgress) => void
): Promise<Blob> {
  const { source, width, height } = await decodeBlob(blob)
  const bitmap =
    source instanceof ImageBitmap ? source : await createImageBitmap(source as HTMLCanvasElement)
  if (width <= 0 || height <= 0) throw new Error('이미지 크기를 읽을 수 없습니다')
  return removeBackgroundAi(bitmap, onProgress)
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
  /** 실제로 쓰인 방식 — ai-fallback은 AI 실패로 리샘플 대체된 경우 */
  method: 'ai' | 'resample' | 'ai-fallback'
}

/** AI 통과 결과 픽셀 상한 — 브라우저 캔버스·메모리 여유를 고려한 값 */
const MAX_AI_OUTPUT_PIXELS = 100_000_000
/** 진행률 배분 — 모델 준비 10%, 타일 추론 88%, 저장 2% */
const AI_PREP_SHARE = 0.1
const AI_TILE_SHARE = 0.88

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
 * 업스케일 — 배율이 큰 경우(plan.aiUsed) 브라우저 내 AI(Real-ESRGAN, upscale/)로
 * 디테일을 복원하며 키우고, 작은 배율이나 AI 실패 시에는 공유 Plan Builder 체인대로
 * 단계별 고품질 리샘플로 처리한다.
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

  const steps: UpscaleRunResult['steps'] = []
  let method: UpscaleRunResult['method'] = 'resample'

  // --- AI 확대: 배율이 커서 리샘플만으로는 흐려지는 경우(plan.aiUsed) ---
  const passes = plan.aiUsed
    ? planPasses(current.width, current.height, plan.totalScale, MAX_AI_OUTPUT_PIXELS)
    : 0
  if (passes > 0) {
    const started = performance.now()
    const baseW = current.width
    const baseH = current.height
    const totalSteps = plan.chain.length
    const report = (overall: number, stage: UpscaleProgress['stage'], cur = 0, total = 1): void =>
      onProgress({
        stage,
        step: Math.min(totalSteps, Math.floor(overall * totalSteps) + 1),
        totalSteps,
        current: cur,
        total,
        overallProgress: overall
      })
    try {
      const bitmap = await upscaleWithAi(
        await createImageBitmap(current),
        options.engine ?? 'general',
        passes,
        (p) => {
          if (p.stage === 'download') report(AI_PREP_SHARE * 0.8 * (p.ratio ?? 0), 'step')
          else if (p.stage === 'init') report(AI_PREP_SHARE, 'step')
          else if (p.stage === 'tile')
            report(
              AI_PREP_SHARE + AI_TILE_SHARE * ((p.current ?? 0) / Math.max(1, p.total ?? 1)),
              'tile',
              p.current,
              p.total
            )
          else report(0.99, 'encode')
        }
      )
      const enlarged = decodeToCanvas(bitmap, bitmap.width, bitmap.height).canvas
      bitmap.close()
      // 모델은 4배 단위라 남는 배율은 고품질 축소·확대로 정확히 맞춘다
      const wantW = Math.max(1, Math.round(baseW * plan.totalScale))
      const wantH = Math.max(1, Math.round(baseH * plan.totalScale))
      current =
        enlarged.width === wantW && enlarged.height === wantH
          ? enlarged
          : drawScaled(enlarged, wantW, wantH, false)
      steps.push({
        step: 1,
        scale: plan.totalScale,
        outW: current.width,
        outH: current.height,
        ms: Math.round(performance.now() - started)
      })
      method = 'ai'
    } catch (err) {
      if (err instanceof Error && err.message === AI_UPSCALE_CANCELLED) throw err
      console.warn('[up] AI 업스케일 실패 — 리샘플로 대체', err)
      method = 'ai-fallback'
    }
  }

  if (method !== 'ai') {
    const weights = cumulativeSquareWeights(plan.chain)
    for (const [index, scale] of plan.chain.entries()) {
      const started = performance.now()
      const outW = Math.max(1, Math.round(current.width * scale))
      const outH = Math.max(1, Math.round(current.height * scale))
      current = drawScaled(current, outW, outH, false)
      steps.push({
        step: index + 1,
        scale,
        outW,
        outH,
        ms: Math.round(performance.now() - started)
      })
      onProgress({
        stage: 'step',
        step: index + 1,
        totalSteps: plan.chain.length,
        current: index + 1,
        total: plan.chain.length,
        overallProgress: overallProgress(weights, index + 1, 1)
      })
    }
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
    plan,
    method
  }
}
