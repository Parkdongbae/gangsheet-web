import { describe, expect, it } from 'vitest'
import {
  MODEL_SCALE,
  TILE_PAD,
  bleedTransparentRgb,
  fillTileInput,
  planPasses,
  planTiles,
  writeTileOutput
} from './tiles'

const TILE = 64
const CORE = TILE - TILE_PAD * 2

describe('planTiles', () => {
  it('코어 영역이 겹치지 않고 이미지 전체를 덮는다', () => {
    const w = 150
    const h = 70
    const covered = new Uint8Array(w * h)
    for (const t of planTiles(w, h, TILE)) {
      for (let y = t.coreY; y < t.coreY + t.coreH; y++) {
        for (let x = t.coreX; x < t.coreX + t.coreW; x++) covered[y * w + x]!++
      }
    }
    expect([...covered].every((v) => v === 1)).toBe(true)
  })

  it('입력 창은 항상 코어를 포함하고 이미지 안쪽에 놓인다', () => {
    for (const t of planTiles(150, 70, TILE)) {
      expect(t.inX).toBeGreaterThanOrEqual(0)
      expect(t.inX).toBeLessThanOrEqual(t.coreX)
      expect(t.inX + TILE).toBeGreaterThanOrEqual(t.coreX + t.coreW)
      expect(t.inY).toBeLessThanOrEqual(t.coreY)
      expect(t.inY + TILE).toBeGreaterThanOrEqual(t.coreY + t.coreH)
    }
  })

  it('타일보다 작은 이미지는 타일 1개로 처리한다', () => {
    const tiles = planTiles(10, 10, TILE)
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toMatchObject({ coreW: 10, coreH: 10, inX: 0, inY: 0 })
  })

  it('코어가 남지 않는 타일 크기는 거부한다', () => {
    expect(() => planTiles(10, 10, TILE_PAD * 2)).toThrow()
  })
})

describe('planPasses', () => {
  it('필요 배율에 맞는 x4 통과 횟수를 고른다', () => {
    expect(planPasses(100, 100, 1, 1e9)).toBe(0)
    expect(planPasses(100, 100, 2, 1e9)).toBe(1)
    expect(planPasses(100, 100, 4, 1e9)).toBe(1)
    expect(planPasses(100, 100, 5, 1e9)).toBe(1)
    expect(planPasses(100, 100, 6, 1e9)).toBe(1)
    expect(planPasses(100, 100, 8, 1e9)).toBe(2)
    expect(planPasses(100, 100, 16, 1e9)).toBe(2)
  })

  it('출력 픽셀 상한을 넘는 통과는 하지 않는다', () => {
    expect(planPasses(3000, 3000, 4, 100_000_000)).toBe(0)
    expect(planPasses(1000, 1000, 16, 100_000_000)).toBe(1)
  })
})

describe('타일 입출력', () => {
  it('항등 확대(최근접)로 왕복하면 원본 4배 이미지가 된다', () => {
    const w = 90
    const h = 50
    const src = new Uint8ClampedArray(w * h * 4)
    for (let p = 0; p < w * h; p++) {
      src[p * 4] = (p * 7) % 256
      src[p * 4 + 1] = (p * 13) % 256
      src[p * 4 + 2] = (p * 29) % 256
      src[p * 4 + 3] = 255
    }
    const outW = w * MODEL_SCALE
    const out = new Uint8ClampedArray(outW * h * MODEL_SCALE * 4)
    const input = new Float32Array(3 * TILE * TILE)
    const side = TILE * MODEL_SCALE
    for (const tile of planTiles(w, h, TILE)) {
      fillTileInput(input, src, w, h, tile, TILE)
      // 가짜 모델: 각 입력 픽셀을 4×4로 복제
      const fake = new Float32Array(3 * side * side)
      for (let c = 0; c < 3; c++) {
        for (let y = 0; y < side; y++) {
          for (let x = 0; x < side; x++) {
            fake[c * side * side + y * side + x] =
              input[c * TILE * TILE + (y >> 2) * TILE + (x >> 2)]!
          }
        }
      }
      writeTileOutput(out, outW, fake, tile, TILE)
    }
    for (const [x, y] of [
      [0, 0],
      [89, 49],
      [CORE, 10],
      [CORE - 1, 49],
      [45, 25]
    ] as const) {
      const s = (y * w + x) * 4
      const d = (y * MODEL_SCALE * outW + x * MODEL_SCALE) * 4
      expect([out[d], out[d + 1], out[d + 2], out[d + 3]]).toEqual([
        src[s],
        src[s + 1],
        src[s + 2],
        255
      ])
    }
  })
})

describe('bleedTransparentRgb', () => {
  it('완전 불투명 이미지는 건드리지 않는다', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255])
    expect(bleedTransparentRgb(data, 2, 1)).toBe(false)
    expect([...data]).toEqual([10, 20, 30, 255, 40, 50, 60, 255])
  })

  it('투명 픽셀의 RGB를 이웃 불투명 색으로 채우고 알파는 유지한다', () => {
    const w = 8
    const data = new Uint8ClampedArray(w * 4)
    for (let x = 0; x < w; x++) {
      const opaque = x < 4
      data.set(opaque ? [200, 100, 50, 255] : [0, 0, 0, 0], x * 4)
    }
    expect(bleedTransparentRgb(data, w, 1)).toBe(true)
    expect([data[4 * 4], data[4 * 4 + 1], data[4 * 4 + 2]]).toEqual([200, 100, 50])
    expect(data[4 * 4 + 3]).toBe(0)
    expect([data[0], data[1], data[2], data[3]]).toEqual([200, 100, 50, 255])
  })
})
