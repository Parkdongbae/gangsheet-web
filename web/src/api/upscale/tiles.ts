/**
 * AI 업스케일 타일 연산 — DOM·워커 API에 의존하지 않는 순수 함수(Vitest 대상).
 *
 * 모델은 고정 크기(tileInput²) 입력만 받게 해 WebGPU 셰이더 재컴파일을 피한다.
 * 타일마다 "코어" 영역만 결과에 쓰고, 둘레 TILE_PAD만큼은 문맥으로만 넣어
 * 타일 경계선이 보이지 않게 한다. 이미지 가장자리에서는 입력 창을 안쪽으로 당기고,
 * 이미지가 타일보다 작으면 가장자리 픽셀을 늘려 채운다.
 */
import { boxBlur } from '../bgRemoval/matting'

export const MODEL_SCALE = 4
/** 타일 둘레 문맥 폭(입력 px) */
export const TILE_PAD = 16

export interface TilePlan {
  /** 결과에 기록할 코어 영역(입력 좌표) */
  coreX: number
  coreY: number
  coreW: number
  coreH: number
  /** 모델 입력 창의 좌상단(입력 좌표) — 창 크기는 항상 tileInput */
  inX: number
  inY: number
}

const windowOrigin = (core: number, length: number, tileInput: number): number =>
  Math.max(0, Math.min(core - TILE_PAD, length - tileInput))

/** tileInput = 모델 입력 한 변(px). 코어는 둘레 TILE_PAD를 뺀 안쪽 */
export function planTiles(width: number, height: number, tileInput: number): TilePlan[] {
  const tileCore = tileInput - TILE_PAD * 2
  if (tileCore <= 0) throw new Error(`타일이 너무 작습니다: ${tileInput}`)
  const tiles: TilePlan[] = []
  for (let coreY = 0; coreY < height; coreY += tileCore) {
    for (let coreX = 0; coreX < width; coreX += tileCore) {
      tiles.push({
        coreX,
        coreY,
        coreW: Math.min(tileCore, width - coreX),
        coreH: Math.min(tileCore, height - coreY),
        inX: windowOrigin(coreX, width, tileInput),
        inY: windowOrigin(coreY, height, tileInput)
      })
    }
  }
  return tiles
}

/** 필요한 배율을 채우는 x4 통과 횟수 — 출력 픽셀 상한을 넘기지 않는 선에서 */
export function planPasses(
  width: number,
  height: number,
  neededScale: number,
  maxOutputPixels: number
): number {
  let passes = 0
  let w = width
  let h = height
  let remaining = neededScale
  // 첫 통과 이후 남은 배율이 작으면(≤1.5배) AI를 한 번 더 돌리지 않는다 — 16배 픽셀을
  // 계산해 놓고 대부분 버리게 되므로, 그 정도는 고품질 리샘플로 마무리한다
  while (remaining > (passes === 0 ? 1.0001 : 1.5) && passes < 3) {
    if (w * MODEL_SCALE * h * MODEL_SCALE > maxOutputPixels) break
    w *= MODEL_SCALE
    h *= MODEL_SCALE
    remaining /= MODEL_SCALE
    passes++
  }
  return passes
}

/** 타일 입력 텐서(CHW, 0..1) 채우기 — 범위를 벗어난 좌표는 가장자리 픽셀로 고정 */
export function fillTileInput(
  out: Float32Array,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  tile: TilePlan,
  tileInput: number
): void {
  const plane = tileInput * tileInput
  for (let ty = 0; ty < tileInput; ty++) {
    const sy = Math.min(height - 1, tile.inY + ty)
    for (let tx = 0; tx < tileInput; tx++) {
      const sx = Math.min(width - 1, tile.inX + tx)
      const i = (sy * width + sx) * 4
      const p = ty * tileInput + tx
      out[p] = rgba[i]! / 255
      out[plane + p] = rgba[i + 1]! / 255
      out[plane * 2 + p] = rgba[i + 2]! / 255
    }
  }
}

/** 모델 출력(CHW, 0..1, tileInput×4²)에서 코어 영역만 결과 RGBA에 기록(알파 255) */
export function writeTileOutput(
  dest: Uint8ClampedArray,
  destWidth: number,
  output: ArrayLike<number>,
  tile: TilePlan,
  tileInput: number
): void {
  const side = tileInput * MODEL_SCALE
  const plane = side * side
  const offX = (tile.coreX - tile.inX) * MODEL_SCALE
  const offY = (tile.coreY - tile.inY) * MODEL_SCALE
  const w = tile.coreW * MODEL_SCALE
  const h = tile.coreH * MODEL_SCALE
  const dx0 = tile.coreX * MODEL_SCALE
  const dy0 = tile.coreY * MODEL_SCALE
  for (let y = 0; y < h; y++) {
    const srcRow = (offY + y) * side + offX
    let d = ((dy0 + y) * destWidth + dx0) * 4
    for (let x = 0; x < w; x++, d += 4) {
      const s = srcRow + x
      dest[d] = output[s]! * 255
      dest[d + 1] = output[plane + s]! * 255
      dest[d + 2] = output[plane * 2 + s]! * 255
      dest[d + 3] = 255
    }
  }
}

/**
 * 투명 픽셀의 RGB를 주변 불투명 색으로 채운다(제자리). 투명 영역의 RGB(보통 검정)가
 * 모델을 거치며 경계에 어두운 테두리로 번지는 것을 막는다.
 * @returns 반투명·투명 픽셀이 하나라도 있었는지
 */
export function bleedTransparentRgb(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): boolean {
  const n = width * height
  let hasAlpha = false
  for (let p = 0; p < n; p++) {
    if (rgba[p * 4 + 3]! < 255) {
      hasAlpha = true
      break
    }
  }
  if (!hasAlpha) return false

  const weight = new Float32Array(n)
  for (let p = 0; p < n; p++) weight[p] = rgba[p * 4 + 3]! / 255
  for (const radius of [4, 16]) {
    const blurredWeight = boxBlur(weight, width, height, radius)
    for (let c = 0; c < 3; c++) {
      const plane = new Float32Array(n)
      for (let p = 0; p < n; p++) plane[p] = rgba[p * 4 + c]! * weight[p]!
      const blurred = boxBlur(plane, width, height, radius)
      for (let p = 0; p < n; p++) {
        const a = weight[p]!
        const bw = blurredWeight[p]!
        if (a >= 0.98 || bw < 1e-4) continue
        rgba[p * 4 + c] = rgba[p * 4 + c]! * a + (blurred[p]! / bw) * (1 - a)
      }
    }
    // 채워진 곳은 다음(더 넓은) 반경에서 다시 덮이지 않게 가중치를 올린다
    for (let p = 0; p < n; p++)
      if (blurredWeight[p]! >= 1e-4) weight[p] = Math.max(weight[p]!, 0.98)
  }
  return true
}
