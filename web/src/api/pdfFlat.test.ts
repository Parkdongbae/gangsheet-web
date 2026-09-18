import { describe, expect, it } from 'vitest'
import { encodePdf } from './pdfFlat'

const fakeJpeg = (fill: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(64)
  bytes[0] = 0xff
  bytes[1] = 0xd8 // SOI
  bytes[2] = 0xff
  bytes[3] = 0xe0
  bytes.fill(fill, 8)
  return bytes
}

/** 바이트열 내 ASCII 패턴 위치 검색 */
function findBytes(pdf: Uint8Array, needle: string, from = 0): number {
  const target = Uint8Array.from(needle, (ch) => ch.charCodeAt(0))
  outer: for (let i = from; i <= pdf.length - target.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (pdf[i + j] !== target[j]) continue outer
    }
    return i
  }
  return -1
}

const textAt = (pdf: Uint8Array, at: number, len: number): string =>
  Array.from(pdf.subarray(at, at + len), (b) => String.fromCharCode(b)).join('')

describe('encodePdf', () => {
  it('물리 크기 MediaBox·DCTDecode 이미지·JPEG 페이로드 무손실 포함', async () => {
    const jpeg = fakeJpeg(0xab)
    const blob = encodePdf({ widthPx: 689, heightPx: 1378, dpi: 350, jpeg })
    const pdf = new Uint8Array(await blob.arrayBuffer())

    expect(textAt(pdf, 0, 8)).toBe('%PDF-1.4')
    expect(findBytes(pdf, '/MediaBox [0 0 141.737 283.474]')).toBeGreaterThan(0)
    expect(findBytes(pdf, '/Filter /DCTDecode')).toBeGreaterThan(0)
    expect(findBytes(pdf, '/Width 689 /Height 1378')).toBeGreaterThan(0)
    expect(findBytes(pdf, `/Length ${jpeg.length} >>`)).toBeGreaterThan(0)

    // stream 본문의 JPEG 바이트가 그대로 존재 — FF D8 쌍 위치에서 시작
    const dctAt = findBytes(pdf, 'DCTDecode')
    let soiAt = -1
    for (let i = dctAt; i < pdf.length - 1; i++) {
      if (pdf[i] === 0xff && pdf[i + 1] === 0xd8) {
        soiAt = i
        break
      }
    }
    expect(soiAt).toBeGreaterThan(0)
    expect(Array.from(pdf.subarray(soiAt, soiAt + jpeg.length))).toEqual(Array.from(jpeg))
  })

  it('xref 오프셋이 실제 객체 위치를 가리킨다', async () => {
    const blob = encodePdf({ widthPx: 100, heightPx: 50, dpi: 350, jpeg: fakeJpeg(0x11) })
    const pdf = new Uint8Array(await blob.arrayBuffer())
    const xrefAt = findBytes(pdf, 'xref\n0 6\n')
    expect(xrefAt).toBeGreaterThan(0)

    for (let i = 1; i <= 5; i++) {
      const entryAt = xrefAt + 9 + i * 20 // 헤더줄 + 이전 항목들 (항목당 20바이트)
      const offset = Number(textAt(pdf, entryAt, 10))
      expect(Number.isFinite(offset)).toBe(true)
      expect(textAt(pdf, offset, 7)).toBe(`${i} 0 obj`)
    }

    const startXrefAt = findBytes(pdf, 'startxref\n', xrefAt)
    const valueEnd = pdf.indexOf(0x0a, startXrefAt + 10)
    expect(Number(textAt(pdf, startXrefAt + 10, valueEnd - startXrefAt - 10))).toBe(xrefAt)
    expect(textAt(pdf, pdf.length - 6, 5)).toBe('%%EOF')
  })

  it('빈 JPEG·0크기 문서는 예외', () => {
    expect(() => encodePdf({ widthPx: 0, heightPx: 10, dpi: 350, jpeg: fakeJpeg(1) })).toThrow()
    expect(() =>
      encodePdf({ widthPx: 10, heightPx: 10, dpi: 350, jpeg: new Uint8Array(0) })
    ).toThrow()
  })
})
