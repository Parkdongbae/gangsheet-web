import { describe, expect, it } from 'vitest'
import {
  applyLevels,
  boxBlur,
  composeAlpha,
  estimateBorderColor,
  fromFloat16,
  normalizeMask,
  removeSolidBackgroundPixels,
  toFloat16,
  toInputTensor
} from './matting'

/** w×h RGBA 버퍼 — fill(x, y)가 [r, g, b, a]를 돌려준다 */
function makeImage(
  w: number,
  h: number,
  fill: (x: number, y: number) => [number, number, number, number]
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(fill(x, y), (y * w + x) * 4)
  }
  return data
}

const alphaAt = (data: Uint8ClampedArray, w: number, x: number, y: number): number =>
  data[(y * w + x) * 4 + 3]!

describe('toInputTensor', () => {
  it('CHW 순서로 v/255 − 0.5 정규화한다', () => {
    const rgba = new Uint8ClampedArray([255, 0, 127.5, 255, 0, 255, 255, 255])
    const out = toInputTensor(
      makeImage(2, 2, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 255, 255, 255])),
      2
    )
    expect(rgba.length).toBe(8)
    expect(out.length).toBe(12)
    expect(out[0]).toBeCloseTo(0.5)
    expect(out[1]).toBeCloseTo(-0.5)
    expect(out[4]).toBeCloseTo(-0.5)
    expect(out[5]).toBeCloseTo(0.5)
  })

  it('투명 픽셀은 흰 바탕으로 합성한다', () => {
    const out = toInputTensor(
      makeImage(1, 1, () => [0, 0, 0, 0]),
      1
    )
    expect([...out]).toEqual([0.5, 0.5, 0.5])
  })
})

describe('normalizeMask', () => {
  it('min-max로 0..1에 맞춘다', () => {
    const out = normalizeMask(new Float32Array([2, 4, 6]))
    expect([...out]).toEqual([0, 0.5, 1])
  })

  it('값이 전부 같으면 0으로 채운다', () => {
    expect([...normalizeMask(new Float32Array([3, 3, 3]))]).toEqual([0, 0, 0])
  })
})

describe('boxBlur', () => {
  it('상수 입력은 그대로 유지한다(가장자리 포함)', () => {
    const out = boxBlur(new Float32Array(25).fill(0.7), 5, 5, 2)
    for (const v of out) expect(v).toBeCloseTo(0.7)
  })

  it('평균을 보존하며 임펄스를 퍼뜨린다', () => {
    const src = new Float32Array(49)
    src[24] = 1
    const out = boxBlur(src, 7, 7, 1)
    expect(out[24]).toBeCloseTo(1 / 9)
    expect(out[0]).toBe(0)
  })
})

describe('applyLevels', () => {
  it('낮은 알파는 자르고 높은 알파는 포화시킨다', () => {
    expect(applyLevels(0.05)).toBe(0)
    expect(applyLevels(0.95)).toBe(1)
    expect(applyLevels(0.5)).toBeCloseTo(0.5)
  })
})

describe('float16 변환', () => {
  it('왕복 시 값이 보존된다', () => {
    const src = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25, 3.5])
    const back = fromFloat16(toFloat16(src))
    for (let i = 0; i < src.length; i++) expect(back[i]).toBeCloseTo(src[i]!, 3)
  })
})

describe('composeAlpha', () => {
  const size = 16

  it('마스크 0 영역은 투명, 1 영역은 불투명으로 남긴다', () => {
    const w = 64
    const h = 64
    // 왼쪽 절반 = 피사체(어두움), 오른쪽 절반 = 배경(밝음)
    const fill = (x: number, total: number): [number, number, number, number] =>
      x < total / 2 ? [30, 30, 30, 255] : [230, 230, 230, 255]
    const full = makeImage(w, h, (x) => fill(x, w))
    const small = makeImage(size, size, (x) => fill(x, size))
    const mask = new Float32Array(size * size)
    for (let y = 0; y < size; y++) for (let x = 0; x < size / 2; x++) mask[y * size + x] = 1

    const opaque = composeAlpha(full, w, h, small, mask, size)
    expect(alphaAt(full, w, 4, 32)).toBe(255)
    expect(alphaAt(full, w, 60, 32)).toBe(0)
    expect(opaque).toBeGreaterThan(w * h * 0.4)
    expect(opaque).toBeLessThan(w * h * 0.6)
  })

  it('빈 마스크면 불투명 픽셀이 0개다', () => {
    const full = makeImage(32, 32, () => [100, 100, 100, 255])
    const small = makeImage(size, size, () => [100, 100, 100, 255])
    expect(composeAlpha(full, 32, 32, small, new Float32Array(size * size), size)).toBe(0)
  })

  it('원본의 기존 투명 영역은 되살리지 않는다', () => {
    const full = makeImage(32, 32, () => [10, 10, 10, 0])
    const small = makeImage(size, size, () => [10, 10, 10, 0])
    const opaque = composeAlpha(full, 32, 32, small, new Float32Array(size * size).fill(1), size)
    expect(opaque).toBe(0)
    expect(alphaAt(full, 32, 16, 16)).toBe(0)
  })
})

describe('removeSolidBackgroundPixels', () => {
  const w = 40
  const h = 40
  const inSquare = (x: number, y: number): boolean => x >= 10 && x < 30 && y >= 10 && y < 30

  it('테두리와 이어진 단색 배경만 지우고 피사체는 보존한다', () => {
    const data = makeImage(w, h, (x, y) =>
      inSquare(x, y) ? [200, 30, 30, 255] : [255, 255, 255, 255]
    )
    expect(removeSolidBackgroundPixels(data, w, h)).toBe(true)
    expect(alphaAt(data, w, 0, 0)).toBe(0)
    expect(alphaAt(data, w, 5, 20)).toBe(0)
    expect(alphaAt(data, w, 20, 20)).toBe(255)
  })

  it('피사체 안에 갇힌 배경색(구멍)은 남긴다', () => {
    const data = makeImage(w, h, (x, y) => {
      if (x >= 18 && x < 22 && y >= 18 && y < 22) return [255, 255, 255, 255]
      return inSquare(x, y) ? [200, 30, 30, 255] : [255, 255, 255, 255]
    })
    removeSolidBackgroundPixels(data, w, h)
    expect(alphaAt(data, w, 20, 20)).toBe(255)
  })

  it('경계의 섞인 픽셀은 부분 알파가 되고 배경색이 걷힌다', () => {
    // x=9 열은 배경과 피사체가 반씩 섞인 안티앨리어싱 픽셀
    const data = makeImage(w, h, (x, y) => {
      if (x === 9 && y >= 10 && y < 30) return [228, 142, 142, 255]
      return inSquare(x, y) ? [200, 30, 30, 255] : [255, 255, 255, 255]
    })
    removeSolidBackgroundPixels(data, w, h)
    const i = (20 * w + 9) * 4
    expect(data[i + 3]).toBeGreaterThan(90)
    expect(data[i + 3]).toBeLessThan(170)
    // 역혼합 후 색은 순수 피사체색에 가까워야 한다
    expect(data[i]).toBeGreaterThan(185)
    expect(data[i + 1]).toBeLessThan(60)
  })

  it('테두리가 전부 투명하면 변경하지 않는다', () => {
    const data = makeImage(w, h, (x, y) => (inSquare(x, y) ? [200, 30, 30, 255] : [0, 0, 0, 0]))
    expect(estimateBorderColor(data, w, h)).toBeNull()
    expect(removeSolidBackgroundPixels(data, w, h)).toBe(false)
  })

  it('배경과 구분되지 않는 단일색 이미지는 전부 투명해진다', () => {
    const data = makeImage(8, 8, () => [255, 255, 255, 255])
    expect(removeSolidBackgroundPixels(data, 8, 8)).toBe(true)
    expect(alphaAt(data, 8, 4, 4)).toBe(0)
  })
})
