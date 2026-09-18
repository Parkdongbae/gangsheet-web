/**
 * 단일 페이지 PDF 라이터 — 갱시트 검수용 인쇄 문서 (웹 파이프라인).
 *
 * 문서를 물리 크기(cm→pt) 페이지 1장에 실어 담는다: 씬 렌더 결과를
 * 흰 배경 합성 → JPEG(canvas DCT) → PDF XObject(/DCTDecode)로 임베드.
 * 구조는 최소 5객체(카탈로그·페이지트리·페이지·이미지·컨텐츠) + xref로
 * 직접 직렬화한다 — 외부 의존 없음, 오프셋은 기록 시점에 추적.
 */

export interface PdfImageSource {
  widthPx: number
  heightPx: number
  dpi: number
  /** 흰 배경으로 합성된 JPEG 바이트 */
  jpeg: Uint8Array<ArrayBuffer>
}

const ascii = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(text, (ch) => ch.charCodeAt(0))

const PT_PER_PX = (dpi: number): number => 72 / dpi

/** pt 치수 직렬화 — 소수 간결화 (PDF 숫자 파서 호환) */
function pt(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}

export function encodePdf(source: PdfImageSource): Blob {
  if (source.widthPx <= 0 || source.heightPx <= 0) throw new Error('문서 크기가 0입니다')
  if (source.jpeg.length === 0) throw new Error('JPEG 페이로드가 비었습니다')

  const widthPt = source.widthPx * PT_PER_PX(source.dpi)
  const heightPt = source.heightPx * PT_PER_PX(source.dpi)
  const content = ascii(`q\n${pt(widthPt)} 0 0 ${pt(heightPt)} 0 0 cm\n/Im0 Do\nQ\n`)

  const chunks: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  const push = (bytes: Uint8Array<ArrayBuffer>): number => {
    chunks.push(bytes)
    offset += bytes.length
    return offset
  }
  const offsets: number[] = []

  push(ascii('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n'))

  offsets[1] = offset
  push(ascii('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'))

  offsets[2] = offset
  push(ascii('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'))

  offsets[3] = offset
  push(
    ascii(
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(widthPt)} ${pt(heightPt)}] ` +
        `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`
    )
  )

  offsets[4] = offset
  push(
    ascii(
      `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${source.widthPx} /Height ${source.heightPx} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${source.jpeg.length} >>\nstream\n`
    )
  )
  push(source.jpeg)
  push(ascii('\nendstream\nendobj\n'))

  offsets[5] = offset
  push(ascii(`5 0 obj\n<< /Length ${content.length} >>\nstream\n`))
  push(content)
  push(ascii('endstream\nendobj\n'))

  const xrefStart = offset
  let xrefText = 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i++) {
    xrefText += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  push(ascii(xrefText))
  push(ascii(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`))

  return new Blob(chunks, { type: 'application/pdf' })
}
