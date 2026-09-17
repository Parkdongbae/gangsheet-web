import { describe, expect, it } from 'vitest'
import { crc32, dpiToPpm, injectPngDpi, parsePngMeta, physChunkData } from './pngMeta'

const U32 = (value: number): Uint8Array =>
  new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  out.set(U32(data.length), 0)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  out.set(U32(crc32(out.subarray(4, 8 + data.length))), 8 + data.length)
  return out
}

function minimalPng(width: number, height: number, withPhys = false): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13)
  ihdr.set(U32(width), 0)
  ihdr.set(U32(height), 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr)
  ]
  if (withPhys) parts.push(chunk('pHYs', physChunkData(72)))
  parts.push(chunk('IDAT', new Uint8Array([0x00, 0x01, 0x02])))
  parts.push(chunk('IEND', new Uint8Array(0)))
  const size = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

describe('crc32', () => {
  it('표준 검증 벡터를 만족한다', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})

describe('dpiToPpm', () => {
  it('350 DPI → 13,780 px/m (0.0254m 환산 반올림)', () => {
    expect(dpiToPpm(350)).toBe(13780)
  })
})

describe('physChunkData', () => {
  it('x/y 밀도와 미터 단위(1)를 인코딩한다', () => {
    const data = physChunkData(350)
    expect(data.length).toBe(9)
    expect(new DataView(data.buffer).getUint32(0)).toBe(13780)
    expect(new DataView(data.buffer).getUint32(4)).toBe(13780)
    expect(data[8]).toBe(1)
  })
})

describe('injectPngDpi ↔ parsePngMeta', () => {
  it('IHDR 직후에 pHYs를 삽입하고 치수·DPI로 왕복된다', () => {
    const src = minimalPng(640, 480)
    const injected = new Uint8Array(injectPngDpi(src.buffer, 350))
    const meta = parsePngMeta(injected)
    expect(meta).toEqual({ width: 640, height: 480, dpi: 350 })
  })

  it('기존 pHYs(72)는 350으로 교체된다 — 청크 단일 유지', () => {
    const src = minimalPng(10, 10, true)
    expect(parsePngMeta(src).dpi).toBe(72)
    const injected = new Uint8Array(injectPngDpi(src.buffer, 350))
    expect(parsePngMeta(injected).dpi).toBe(350)
    let physCount = 0
    let offset = 8
    while (offset + 12 <= injected.length) {
      const length = new DataView(injected.buffer, offset).getUint32(0)
      const type = String.fromCharCode(
        injected[offset + 4]!,
        injected[offset + 5]!,
        injected[offset + 6]!,
        injected[offset + 7]!
      )
      if (type === 'pHYs') physCount++
      offset += 12 + length
    }
    expect(physCount).toBe(1)
  })

  it('IEND 이후 구조는 보존된다 (총 길이 = 원본 + 21B)', () => {
    const src = minimalPng(3, 3)
    const injected = new Uint8Array(injectPngDpi(src.buffer, 350))
    expect(injected.length).toBe(src.length + 21)
    expect(injected.subarray(injected.length - 12)).toEqual(src.subarray(src.length - 12))
  })

  it('PNG 시그니처가 아니면 예외', () => {
    expect(() => injectPngDpi(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer, 350)).toThrow()
  })
})
