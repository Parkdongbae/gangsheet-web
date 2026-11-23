/**
 * 배경 제거 픽셀 연산 — DOM·워커 API에 의존하지 않는 순수 함수 모음(Vitest 대상).
 *
 * AI 모드: ISNet 마스크(1024²) → 원본 해상도 알파
 *   1) fast guided filter — 저해상도에서 구한 선형 계수(a, b)를 원본 좌표로 보간해
 *      원본 휘도에 적용, 마스크 경계를 실제 이미지 경계(머리카락 등)에 맞춘다
 *   2) 알파 레벨 — 배경에 남는 옅은 안개(낮은 알파)는 잘라내고 내부는 완전 불투명으로
 *   3) blur-fusion 전경색 추정 — 반투명 경계 픽셀에 섞인 배경색을 걷어낸다(디프린지)
 *
 * 단색 모드: 테두리 색과 연결된 영역을 플러드필로 제거하고, 경계 1~2px은 색 거리
 * 기반 부분 알파 + 배경색 역혼합으로 안티앨리어싱을 보존한다(로고·글자용).
 */

/** ISNet 입력 한 변(px) */
export const MODEL_SIZE = 1024

// ---- AI 모드 파라미터 ----
/** guided filter 박스 반경(1024² 기준 px) */
export const GUIDED_RADIUS = 6
/** guided filter 정규화 항 — 작을수록 이미지 경계를 강하게 따른다 */
export const GUIDED_EPS = 2e-3
/** 이 값 이하의 알파는 0으로(배경 잔상 제거) */
export const ALPHA_LEVEL_LOW = 0.1
/** 이 값 이상의 알파는 1로(내부 구멍 방지) */
export const ALPHA_LEVEL_HIGH = 0.9
/** 마스크가 이 범위를 벗어나면 확정 배경/전경 — 경계 보정을 생략한다 */
const BAND_LOW = 0.01
const BAND_HIGH = 0.99
/** 전경/배경색 추정용 블러 반경(1024² 기준 px) */
const FUSION_RADIUS = 10

// ---- 단색 모드 파라미터 ----
/** 배경으로 확정하는 RGB 유클리드 거리 */
export const SOLID_TOLERANCE = 30
/** 전경색이 배경과 이보다 가까우면 경계 보정을 하지 않는다(노이즈 증폭 방지) */
const SOLID_MIN_CONTRAST = 24

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** RGBA(size²) → CHW Float32 텐서. 정규화는 rembg ISNet과 동일: v/255 − 0.5 */
export function toInputTensor(rgba: Uint8ClampedArray, size: number = MODEL_SIZE): Float32Array {
  const plane = size * size
  const out = new Float32Array(plane * 3)
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    // 투명 픽셀은 흰 바탕에 합성해 모델이 검은 배경으로 오인하지 않게 한다
    const a = rgba[i + 3]! / 255
    out[p] = (rgba[i]! * a + 255 * (1 - a)) / 255 - 0.5
    out[plane + p] = (rgba[i + 1]! * a + 255 * (1 - a)) / 255 - 0.5
    out[plane * 2 + p] = (rgba[i + 2]! * a + 255 * (1 - a)) / 255 - 0.5
  }
  return out
}

/** 모델 출력 → 0..1 min-max 정규화 (제자리). 값이 전부 같으면 0으로 채운다 */
export function normalizeMask(raw: Float32Array): Float32Array {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i]!
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min
  if (!(range > 1e-6)) return raw.fill(0)
  for (let i = 0; i < raw.length; i++) raw[i] = (raw[i]! - min) / range
  return raw
}

/** 분리형 박스 블러(가장자리는 유효 창 크기로 평균) */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let x = 0; x <= Math.min(r, w - 1); x++) sum += src[row + x]!
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r)
      const hi = Math.min(w - 1, x + r)
      tmp[row + x] = sum / (hi - lo + 1)
      if (x + r + 1 < w) sum += src[row + x + r + 1]!
      if (x - r >= 0) sum -= src[row + x - r]!
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = 0; y <= Math.min(r, h - 1); y++) sum += tmp[y * w + x]!
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r)
      const hi = Math.min(h - 1, y + r)
      out[y * w + x] = sum / (hi - lo + 1)
      if (y + r + 1 < h) sum += tmp[(y + r + 1) * w + x]!
      if (y - r >= 0) sum -= tmp[(y - r) * w + x]!
    }
  }
  return out
}

/** RGBA → 0..1 휘도 */
export function lumaOf(rgba: Uint8ClampedArray, count: number): Float32Array {
  const out = new Float32Array(count)
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    out[p] = (0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!) / 255
  }
  return out
}

/** guided filter 선형 계수(평균화된 a, b) — q = a·I + b */
export function guidedCoeffs(
  guide: Float32Array,
  mask: Float32Array,
  w: number,
  h: number,
  r: number = GUIDED_RADIUS,
  eps: number = GUIDED_EPS
): { a: Float32Array; b: Float32Array } {
  const n = w * h
  const ii = new Float32Array(n)
  const ip = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    ii[i] = guide[i]! * guide[i]!
    ip[i] = guide[i]! * mask[i]!
  }
  const meanI = boxBlur(guide, w, h, r)
  const meanP = boxBlur(mask, w, h, r)
  const meanII = boxBlur(ii, w, h, r)
  const meanIP = boxBlur(ip, w, h, r)
  const a = ii
  const b = ip
  for (let i = 0; i < n; i++) {
    const varI = meanII[i]! - meanI[i]! * meanI[i]!
    const cov = meanIP[i]! - meanI[i]! * meanP[i]!
    const ai = cov / (varI + eps)
    a[i] = ai
    b[i] = meanP[i]! - ai * meanI[i]!
  }
  return { a: boxBlur(a, w, h, r), b: boxBlur(b, w, h, r) }
}

/** 알파 레벨 보정 — [low, high] 구간을 0..1로 펼친다 */
export function applyLevels(alpha: number): number {
  return clamp01((alpha - ALPHA_LEVEL_LOW) / (ALPHA_LEVEL_HIGH - ALPHA_LEVEL_LOW))
}

interface AxisMap {
  i0: Int32Array
  i1: Int32Array
  f: Float32Array
}

/** 원본 축 좌표 → 저해상도 격자 보간 인덱스·가중치 (픽셀 중심 정렬) */
function axisMap(full: number, small: number): AxisMap {
  const i0 = new Int32Array(full)
  const i1 = new Int32Array(full)
  const f = new Float32Array(full)
  const ratio = small / full
  for (let x = 0; x < full; x++) {
    const u = Math.min(small - 1, Math.max(0, (x + 0.5) * ratio - 0.5))
    const base = Math.floor(u)
    i0[x] = base
    i1[x] = Math.min(small - 1, base + 1)
    f[x] = u - base
  }
  return { i0, i1, f }
}

/**
 * AI 마스크를 원본 해상도 RGBA에 제자리 적용한다.
 *
 * @param full   원본 RGBA(w×h) — 알파·경계 RGB가 갱신된다
 * @param small  원본을 size×size로 줄인 RGBA(모델 입력과 같은 그림)
 * @param mask   0..1 마스크(size×size)
 * @returns 불투명(알파>0) 픽셀 수 — 0이면 피사체를 찾지 못한 것
 */
export function composeAlpha(
  full: Uint8ClampedArray,
  w: number,
  h: number,
  small: Uint8ClampedArray,
  mask: Float32Array,
  size: number = MODEL_SIZE
): number {
  const n = size * size
  const { a, b } = guidedCoeffs(lumaOf(small, n), mask, size, size)

  // 전경/배경 평균색(저해상도) — blur-fusion의 F̂, B̂
  const wf = new Float32Array(n)
  const wb = new Float32Array(n)
  const chan: Float32Array[] = []
  for (let c = 0; c < 3; c++) {
    const f = new Float32Array(n)
    const g = new Float32Array(n)
    for (let p = 0; p < n; p++) {
      const m = applyLevels(mask[p]!)
      const v = small[p * 4 + c]!
      f[p] = m * v
      g[p] = (1 - m) * v
      if (c === 0) {
        wf[p] = m
        wb[p] = 1 - m
      }
    }
    chan.push(boxBlur(f, size, size, FUSION_RADIUS), boxBlur(g, size, size, FUSION_RADIUS))
  }
  const wfB = boxBlur(wf, size, size, FUSION_RADIUS)
  const wbB = boxBlur(wb, size, size, FUSION_RADIUS)

  const mx = axisMap(w, size)
  const my = axisMap(h, size)
  let opaque = 0

  for (let y = 0; y < h; y++) {
    const r0 = my.i0[y]! * size
    const r1 = my.i1[y]! * size
    const fy = my.f[y]!
    for (let x = 0; x < w; x++) {
      const c0 = mx.i0[x]!
      const c1 = mx.i1[x]!
      const fx = mx.f[x]!
      const w00 = (1 - fx) * (1 - fy)
      const w10 = fx * (1 - fy)
      const w01 = (1 - fx) * fy
      const w11 = fx * fy
      const k00 = r0 + c0
      const k10 = r0 + c1
      const k01 = r1 + c0
      const k11 = r1 + c1
      const i = (y * w + x) * 4
      const srcA = full[i + 3]!

      const m = mask[k00]! * w00 + mask[k10]! * w10 + mask[k01]! * w01 + mask[k11]! * w11
      if (m <= BAND_LOW || srcA === 0) {
        full[i + 3] = 0
        continue
      }
      if (m >= BAND_HIGH) {
        if (srcA > 0) opaque++
        continue
      }

      const R = full[i]!
      const G = full[i + 1]!
      const B = full[i + 2]!
      const luma = (0.299 * R + 0.587 * G + 0.114 * B) / 255
      const ga = a[k00]! * w00 + a[k10]! * w10 + a[k01]! * w01 + a[k11]! * w11
      const gb = b[k00]! * w00 + b[k10]! * w10 + b[k01]! * w01 + b[k11]! * w11
      // guided 결과와 원 마스크를 섞어 과도한 텍스처 전이를 억제한다
      const alpha = applyLevels(clamp01(0.7 * (ga * luma + gb) + 0.3 * m))
      if (alpha <= 0) {
        full[i + 3] = 0
        continue
      }
      if (alpha < 1) {
        const sf = wfB[k00]! * w00 + wfB[k10]! * w10 + wfB[k01]! * w01 + wfB[k11]! * w11
        const sb = wbB[k00]! * w00 + wbB[k10]! * w10 + wbB[k01]! * w01 + wbB[k11]! * w11
        if (sf > 1e-3 && sb > 1e-3) {
          for (let c = 0; c < 3; c++) {
            const fMap = chan[c * 2]!
            const bMap = chan[c * 2 + 1]!
            const fHat =
              (fMap[k00]! * w00 + fMap[k10]! * w10 + fMap[k01]! * w01 + fMap[k11]! * w11) / sf
            const bHat =
              (bMap[k00]! * w00 + bMap[k10]! * w10 + bMap[k01]! * w01 + bMap[k11]! * w11) / sb
            const src = full[i + c]!
            full[i + c] = fHat + alpha * (src - alpha * fHat - (1 - alpha) * bHat)
          }
        }
      }
      const outA = Math.round(alpha * srcA)
      full[i + 3] = outA
      if (outA > 0) opaque++
    }
  }
  return opaque
}

// ---- 단색 배경 모드 ----

const median = (values: number[]): number => {
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** 테두리 픽셀 중앙값으로 배경색 추정 — 테두리가 전부 투명이면 null */
export function estimateBorderColor(
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
 * 단색 배경 제거(제자리) — 테두리와 이어진 배경색 영역을 투명화하고 경계를 다듬는다.
 * @returns 변경 여부 (배경이 없거나 이미 투명하면 false)
 */
export function removeSolidBackgroundPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance: number = SOLID_TOLERANCE
): boolean {
  const bg = estimateBorderColor(data, width, height)
  if (!bg) return false
  const [bgR, bgG, bgB] = bg
  const tolSq = tolerance * tolerance
  const pixelCount = width * height

  const distSq = (i: number): number => {
    const dr = data[i]! - bgR
    const dg = data[i + 1]! - bgG
    const db = data[i + 2]! - bgB
    return dr * dr + dg * dg + db * db
  }

  // 1) 테두리에서 시작하는 4방향 플러드필
  const removed = new Uint8Array(pixelCount)
  const stack = new Int32Array(pixelCount)
  let top = 0
  const seed = (p: number): void => {
    if (removed[p] === 1) return
    const i = p * 4
    if (data[i + 3]! >= 16 && distSq(i) > tolSq) return
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
  let removedCount = 0
  while (top > 0) {
    const p = stack[--top]!
    removedCount++
    const x = p % width
    if (x > 0) seed(p - 1)
    if (x < width - 1) seed(p + 1)
    if (p >= width) seed(p - width)
    if (p < pixelCount - width) seed(p + width)
  }
  if (removedCount === 0) return false

  // 2) 경계 2링 수집 — ring 1: 제거 영역과 8방향 접촉, ring 2: ring 1과 접촉
  const ring = new Uint8Array(pixelCount)
  const touches = (p: number, x: number, y: number, src: Uint8Array, value: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy
      if (yy < 0 || yy >= height) continue
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= width || (dx === 0 && dy === 0)) continue
        if (src[p + dy * width + dx] === value) return true
      }
    }
    return false
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (removed[p] === 0 && touches(p, x, y, removed, 1)) ring[p] = 1
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (removed[p] === 0 && ring[p] === 0 && touches(p, x, y, ring, 1)) ring[p] = 2
    }
  }

  // 3) 경계 픽셀: 주변(5×5)에서 배경과 가장 먼 색을 전경으로 보고 혼합 비율 추정
  //    P = αF + (1−α)B  →  α ≈ |P−B| / |F−B|,  C = B + (P−B)/α
  const edits: number[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (ring[p] === 0) continue
      const i = p * 4
      const d = Math.sqrt(distSq(i))
      let dMax = d
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          const q = yy * width + xx
          if (removed[q] === 1 || ring[q] !== 0) continue
          const dq = Math.sqrt(distSq(q * 4))
          if (dq > dMax) dMax = dq
        }
      }
      if (dMax < SOLID_MIN_CONTRAST) continue
      const alpha = d / dMax
      if (alpha >= 0.92) continue
      const al = Math.max(alpha, 0.04)
      edits.push(
        p,
        bgR + (data[i]! - bgR) / al,
        bgG + (data[i + 1]! - bgG) / al,
        bgB + (data[i + 2]! - bgB) / al,
        alpha
      )
    }
  }

  for (let p = 0; p < pixelCount; p++) if (removed[p] === 1) data[p * 4 + 3] = 0
  for (let e = 0; e < edits.length; e += 5) {
    const i = edits[e]! * 4
    data[i] = edits[e + 1]!
    data[i + 1] = edits[e + 2]!
    data[i + 2] = edits[e + 3]!
    data[i + 3] = Math.round(data[i + 3]! * edits[e + 4]!)
  }
  return true
}

// ---- float16 변환 (fp16 모델 입출력용) ----

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

export function toFloat16(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length)
  for (let i = 0; i < src.length; i++) {
    f32[0] = src[i]!
    const x = u32[0]!
    const sign = (x >>> 16) & 0x8000
    const exp = ((x >>> 23) & 0xff) - 127 + 15
    const mant = x & 0x7fffff
    if (exp <= 0) {
      out[i] = exp < -10 ? sign : sign | ((mant | 0x800000) >> (14 - exp))
    } else if (exp >= 31) {
      out[i] = sign | 0x7c00
    } else {
      out[i] = sign | (exp << 10) | (mant >> 13)
    }
  }
  return out
}

export function fromFloat16(src: Uint16Array): Float32Array {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) {
    const hbits = src[i]!
    const sign = hbits & 0x8000 ? -1 : 1
    const exp = (hbits >> 10) & 0x1f
    const mant = hbits & 0x3ff
    if (exp === 0) out[i] = sign * Math.pow(2, -14) * (mant / 1024)
    else if (exp === 31) out[i] = mant ? NaN : sign * Infinity
    else out[i] = sign * Math.pow(2, exp - 15) * (1 + mant / 1024)
  }
  return out
}
