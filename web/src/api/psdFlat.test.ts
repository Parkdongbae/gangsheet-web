import { describe, expect, it } from 'vitest'
import { writePsd } from 'ag-psd'
import { encodeFlattenedPsd, packBitsRow, patchPsdResolution } from './psdFlat'

/** 구조적 ImageData 팩토리 — Node 환경에 DOM ImageData가 없어 순수 객체로 대체 */
function imageData(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number]
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y)
      const i = (y * width + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return { data, width, height, colorSpace: 'srgb' }
}

function decodePackBits(packed: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < packed.length) {
    const control = packed[i++]!
    if (control >= 128) {
      const count = 257 - control
      const value = packed[i++]!
      for (let k = 0; k < count; k++) out.push(value)
    } else {
      for (let k = 0; k <= control; k++) out.push(packed[i++]!)
    }
  }
  return new Uint8Array(out)
}

describe('packBitsRow', () => {
  it('균일 행은 반복 런으로 인코딩된다', () => {
    const src = new Uint8Array(100).fill(0xaa)
    const out = new Uint8Array(256)
    const n = packBitsRow(src, src.length, out)
    expect(n).toBeLessThan(6)
    expect(decodePackBits(out.subarray(0, n))).toEqual(src)
  })

  it('무작위 행은 리터럴로 인코딩되어 무손실 복원된다', () => {
    const src = new Uint8Array(97)
    for (let i = 0; i < src.length; i++) src[i] = (i * 37 + 11) % 251
    const out = new Uint8Array(512)
    const n = packBitsRow(src, src.length, out)
    expect(decodePackBits(out.subarray(0, n))).toEqual(src)
  })

  it('혼합 행(런+리터럴+런) 복원', () => {
    const src = new Uint8Array(300)
    src.fill(7, 0, 50)
    for (let i = 50; i < 130; i++) src[i] = i % 253
    src.fill(200, 130)
    const out = new Uint8Array(1024)
    const n = packBitsRow(src, src.length, out)
    expect(decodePackBits(out.subarray(0, n))).toEqual(src)
  })
})

describe('encodeFlattenedPsd', () => {
  const W = 17
  const H = 9
  const img = imageData(W, H, (x, y) => [(x * 5) % 256, (y * 23) % 256, ((x + y) * 3) % 256, 255])

  function parse(blob: Blob): Promise<Uint8Array> {
    return blob.arrayBuffer().then((buf) => new Uint8Array(buf))
  }

  it('헤더·ResolutionInfo·RLE 구조가 Photoshop 규격을 따른다', async () => {
    const blob = encodeFlattenedPsd({
      width: W,
      height: H,
      dpi: 350,
      read: (y, h) => imgDataSlice(img, y, h)
    })
    const psd = await parse(blob)
    const view = new DataView(psd.buffer, psd.byteOffset, psd.byteLength)
    expect(String.fromCharCode(psd[0]!, psd[1]!, psd[2]!, psd[3]!)).toBe('8BPS')
    expect(view.getUint16(12)).toBe(3)
    expect(view.getUint32(14)).toBe(H)
    expect(view.getUint32(18)).toBe(W)
    expect(view.getUint16(22)).toBe(8)
    expect(view.getUint16(24)).toBe(3)

    const colorModeLen = view.getUint32(26)
    expect(colorModeLen).toBe(0)
    const resourcesStart = 26 + 4 + colorModeLen
    const resourcesLen = view.getUint32(resourcesStart)
    expect(resourcesLen).toBe(28)
    expect(
      String.fromCharCode(
        psd[resourcesStart + 4]!,
        psd[resourcesStart + 5]!,
        psd[resourcesStart + 6]!,
        psd[resourcesStart + 7]!
      )
    ).toBe('8BIM')
    expect(view.getUint16(resourcesStart + 8)).toBe(1005)
    expect(view.getUint32(resourcesStart + 12)).toBe(16)
    expect(view.getInt32(resourcesStart + 16)).toBe(350 * 65536)

    const layerMaskStart = resourcesStart + 4 + resourcesLen
    expect(view.getUint32(layerMaskStart)).toBe(0)
    const compression = view.getUint16(layerMaskStart + 4)
    expect(compression).toBe(1)

    const countsStart = layerMaskStart + 6
    const channelSize = W * H
    const decoded: Uint8Array[] = []
    for (let c = 0; c < 3; c++) {
      const channel = new Uint8Array(channelSize)
      let readAt = countsStart + 6 * H
      // 앞 채널들의 packed 데이터를 건너뛴다
      for (let pc = 0; pc < c; pc++) {
        for (let row = 0; row < H; row++) readAt += view.getUint16(countsStart + (pc * H + row) * 2)
      }
      for (let row = 0; row < H; row++) {
        const packedLen = view.getUint16(countsStart + (c * H + row) * 2)
        const rowBytes = decodePackBits(psd.subarray(readAt, readAt + packedLen))
        expect(rowBytes.length).toBe(W)
        rowBytes.forEach((b, x) => (channel[row * W + x] = b))
        readAt += packedLen
      }
      decoded.push(channel)
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        expect([decoded[0]![y * W + x], decoded[1]![y * W + x], decoded[2]![y * W + x]]).toEqual([
          img.data[i],
          img.data[i + 1],
          img.data[i + 2]
        ])
      }
    }
  })

  it('30,000px 초과 문서는 PSD 규격 오류', () => {
    expect(() =>
      encodeFlattenedPsd({
        width: 30001,
        height: 10,
        dpi: 350,
        read: () => imageData(1, 1, () => [0, 0, 0, 255])
      })
    ).toThrow()
  })

  it('비압축성 이미지가 스트립 버퍼를 넘지 않는다 (회귀: Offset is out of bounds)', () => {
    const W = 64
    const H = 130
    const noisy = imageData(W, H, (x, y) => {
      const v = ((x + y) % 2) * 255
      return [v, v, v, 255]
    })
    let blob: Blob
    expect(() => {
      blob = encodeFlattenedPsd({
        width: W,
        height: H,
        dpi: 350,
        read: (y, h) => imgDataSlice(noisy, y, h)
      })
    }).not.toThrow()
    expect(blob!).toBeInstanceOf(Blob)
    // 3채널 × 130행 × 65B(완전 리터럴) = 25,350B — 구버퍼(채널 1개분)였다면 RangeError
    expect(blob!.size).toBeGreaterThan(25_350)
  })
})

function imgDataSlice(full: ImageData, y: number, h: number): ImageData {
  const width = full.width
  const data = new Uint8ClampedArray(width * h * 4)
  data.set(full.data.subarray(y * width * 4, (y + h) * width * 4))
  return { data, width, height: h, colorSpace: 'srgb' }
}

describe('patchPsdResolution', () => {
  function fakePsd(withRes1005: boolean): ArrayBuffer {
    const resource = (id: number, data: Uint8Array): Uint8Array => {
      const block = new Uint8Array(12 + data.length + (data.length % 2))
      const v = new DataView(block.buffer)
      block.set([0x38, 0x42, 0x49, 0x4d], 0)
      v.setUint16(4, id)
      v.setUint16(6, 0)
      v.setUint32(8, data.length)
      block.set(data, 12)
      return block
    }
    const resources = [resource(1000, new Uint8Array([1, 2, 3]))]
    if (withRes1005) resources.push(resource(1005, new Uint8Array(16).fill(9)))
    const resSection = resources.reduce((sum, r) => sum + r.length, 0)
    const header = new Uint8Array(26)
    const v = new DataView(header.buffer)
    header.set([0x38, 0x42, 0x50, 0x53], 0)
    v.setUint16(12, 3)
    v.setUint32(14, 4)
    v.setUint32(18, 6)
    v.setUint16(22, 8)
    v.setUint16(24, 3)
    const parts: Uint8Array[] = [header, new Uint8Array(4), new Uint8Array(4)]
    new DataView(parts[1]!.buffer).setUint32(0, 0)
    new DataView(parts[2]!.buffer).setUint32(0, resSection)
    parts.push(...resources)
    parts.push(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    const size = parts.reduce((sum, p) => sum + p.length, 0)
    const out = new Uint8Array(size)
    let at = 0
    for (const part of parts) {
      out.set(part, at)
      at += part.length
    }
    return out.buffer
  }

  function findRes1005(psd: Uint8Array): { offset: number; dpi: number } | null {
    const view = new DataView(psd.buffer, psd.byteOffset, psd.byteLength)
    const colorModeLen = view.getUint32(26)
    const resourcesStart = 30 + colorModeLen
    const sectionEnd = resourcesStart + 4 + view.getUint32(resourcesStart)
    let offset = resourcesStart + 4
    while (offset + 12 <= sectionEnd) {
      if (
        String.fromCharCode(psd[offset]!, psd[offset + 1]!, psd[offset + 2]!, psd[offset + 3]!) !==
        '8BIM'
      )
        return null
      const id = view.getUint16(offset + 4)
      const nameLen = view.getUint16(offset + 6)
      const dataLen = view.getUint32(offset + 8 + nameLen * 2)
      if (id === 1005) {
        return {
          offset: offset + 12 + nameLen * 2,
          dpi: view.getInt32(offset + 12 + nameLen * 2) / 65536
        }
      }
      offset += 12 + nameLen * 2 + dataLen + (dataLen % 2)
    }
    return null
  }

  it('1005가 없으면 삽입하고 본문은 보존된다', () => {
    const patched = new Uint8Array(patchPsdResolution(fakePsd(false), 350))
    const found = findRes1005(patched)
    expect(found?.dpi).toBe(350)
    expect(patched.subarray(patched.length - 4)).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
  })

  it('기존 1005는 값만 교체된다', () => {
    const patched = new Uint8Array(patchPsdResolution(fakePsd(true), 350))
    const found = findRes1005(patched)
    expect(found?.dpi).toBe(350)
    expect(patched.subarray(patched.length - 4)).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
  })

  it('ag-psd 실산출 버퍼도 파싱·패치된다 (레이어 PSD 경로 회귀)', () => {
    const W = 4
    const H = 3
    const composite = imageData(W, H, (x, y) => [x * 40, y * 60, 128, 255])
    const layer = imageData(2, 2, () => [255, 0, 0, 255])
    const buffer = writePsd({
      width: W,
      height: H,
      channels: 3,
      children: [{ name: '레드', left: 1, top: 1, imageData: layer }],
      imageData: composite
    })
    const patched = new Uint8Array(patchPsdResolution(buffer, 350))
    const found = findRes1005(patched)
    expect(found?.dpi).toBe(350)
    expect(patched[0]).toBe(0x38)
    expect(patched.subarray(patched.length - 4)).toEqual(
      new Uint8Array(buffer.slice(buffer.byteLength - 4))
    )
  })
})
