/**
 * 평면(flattened) RGB 8bit PSD 라이터 — Python 사이드카(psd_writer.py CMYK)의
 * 웹 대체. CMYK 변환은 브라우저에서 불가(lcms 없음)하므로 RGB 8bit + 350 DPI
 * ResolutionInfo로 저장한다 (데스크톱 대비 차이는 web/README.md 참조).
 *
 * 구조(Photoshop File Format):
 *   Header(26B) → ColorModeData(len 0) → ImageResources(1005 ResolutionInfo)
 *   → LayerAndMaskInfo(len 0) → ImageData(compression=1 RLE)
 * RLE 섹션은 "전체 채널·행의 압축 길이 테이블 u16"이 데이터보다 먼저 오므로
 * 2-패스 인코딩으로 피크 메모리를 스트립 단위로 억제한다(초대형 문서 대응).
 */

export interface StripReader {
  /** 문서 y행부터 h행 픽셀 반환 (RGBA ImageData, width는 문서 전체 폭) */
  (y: number, h: number): ImageData
}

const STRIP_ROWS = 256

/** PackBits 1행 인코딩 — 반복 3바이트 이상을 런으로 묶고 나머지는 리터럴 */
export function packBitsRow(src: Uint8Array, length: number, out: Uint8Array): number {
  let i = 0
  let outAt = 0
  while (i < length) {
    // 런 탐색 — 같은 바이트 연속 길이
    let run = 1
    while (run < 128 && i + run < length && src[i + run] === src[i]) run++
    if (run >= 3) {
      out[outAt++] = 257 - run // 129..255 ↔ 3..128 반복
      out[outAt++] = src[i]!
      i += run
      continue
    }
    // 리터럴 — 다음 런 시작점까지 적립 (최대 128)
    let literals = 1
    while (literals < 128 && i + literals < length) {
      let next = 1
      while (
        next < 3 &&
        i + literals + next < length &&
        src[i + literals + next] === src[i + literals + next - 1]
      ) {
        next++
      }
      if (next >= 3) break
      literals++
    }
    if (i + literals >= length) literals = length - i
    out[outAt++] = literals - 1 // 0..127 ↔ 1..128 리터럴
    for (let k = 0; k < literals; k++) out[outAt++] = src[i + k]!
    i += literals
  }
  return outAt
}

/** 압축 결과 상한 — 최악 축소 비율 대비 여유 (128리터럴→130B ≈ ×1.016) */
function scratchSize(width: number): number {
  return width + (width >> 5) + 16
}

function fixed16x16(value: number): number {
  return Math.round(value * 65536)
}

/** ResolutionInfo(1005) 리소스 블록 — 16바이트 데이터 */
function resolutionResource(dpi: number): Uint8Array {
  const data = new Uint8Array(16)
  const view = new DataView(data.buffer)
  view.setInt32(0, fixed16x16(dpi)) // hRes
  view.setUint16(4, 1) // hResUnit: 1 = px/inch
  view.setUint16(6, 1) // widthUnit: 1 = inch
  view.setInt32(8, fixed16x16(dpi)) // vRes
  view.setUint16(12, 1) // vResUnit
  view.setUint16(14, 1) // heightUnit
  const block = new Uint8Array(28) // '8BIM'(4) + id(2) + 이름(2) + 크기(4) + 데이터(16)
  const blockView = new DataView(block.buffer)
  block.set([0x38, 0x42, 0x49, 0x4d], 0) // '8BIM'
  blockView.setUint16(4, 1005)
  blockView.setUint16(6, 0)
  blockView.setUint32(8, data.length)
  block.set(data, 12)
  return block
}

/**
 * 평면 RGB PSD 생성.
 * @param opts.width 문서 폭(px) @param opts.height 높이(px) @param opts.dpi 해상도
 * @param opts.read 스트립 리더 (워커: OffscreenCanvasRenderingContext2D.getImageData)
 */
export function encodeFlattenedPsd(opts: {
  width: number
  height: number
  dpi: number
  read: StripReader
}): Blob {
  const { width, height, dpi, read } = opts
  if (width <= 0 || height <= 0) throw new Error('문서 크기가 0입니다')
  if (width > 30000 || height > 30000) {
    throw new Error(`PSD 최대 치수(변당 30,000px) 초과: ${width}×${height}`)
  }

  // ---- 패스 1: 행별 RLE 길이 산출 (u16 카운트 테이블용) ----
  const scratch = new Uint8Array(scratchSize(width))
  const rowBytes = new Uint8Array(width)
  const channelCounts = new Uint16Array(3 * height) // [R,G,B] 채널 평면 순서 × 행
  const extractRow = (strip: ImageData, rowInStrip: number, channel: number): void => {
    const data = strip.data
    for (let x = 0; x < width; x++) rowBytes[x] = data[(rowInStrip * width + x) * 4 + channel]!
  }
  for (let y0 = 0; y0 < height; y0 += STRIP_ROWS) {
    const rows = Math.min(STRIP_ROWS, height - y0)
    const strip = read(y0, rows)
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < rows; y++) {
        extractRow(strip, y, c)
        channelCounts[c * height + y0 + y] = packBitsRow(rowBytes, width, scratch)
      }
    }
  }

  // ---- 헤더/리소스/레이어 섹션 ----
  const header = new Uint8Array(26)
  const hv = new DataView(header.buffer)
  header.set([0x38, 0x42, 0x50, 0x53], 0) // '8BPS'
  hv.setUint16(4, 1) // version 1 (오프셋 4 — 2~3은 시그니처)
  hv.setUint16(12, 3) // channels RGB
  hv.setUint32(14, height)
  hv.setUint32(18, width)
  hv.setUint16(22, 8) // depth
  hv.setUint16(24, 3) // mode 3 = RGB

  const colorModeLen = new Uint8Array(4) // 0
  const resource = resolutionResource(dpi)
  const resourceSection = new Uint8Array(4 + resource.length)
  new DataView(resourceSection.buffer).setUint32(0, resource.length)
  resourceSection.set(resource, 4)
  const layerMaskLen = new Uint8Array(4) // 0

  const compression = new Uint8Array(2)
  new DataView(compression.buffer).setUint16(0, 1) // RLE

  // 카운트 테이블 (채널순 R,G,B × 각 행)
  const countsBytes = new Uint8Array(channelCounts.length * 2)
  const countsView = new DataView(countsBytes.buffer)
  for (let i = 0; i < channelCounts.length; i++) countsView.setUint16(i * 2, channelCounts[i]!)

  // ---- 패스 2: 행별 재인코딩 → 스트립 단위 청크 적립 ----
  const parts: BlobPart[] = [
    header,
    colorModeLen,
    resourceSection,
    layerMaskLen,
    compression,
    countsBytes
  ]
  const stripBuffer = new Uint8Array(scratchSize(width) * STRIP_ROWS)
  for (let y0 = 0; y0 < height; y0 += STRIP_ROWS) {
    const rows = Math.min(STRIP_ROWS, height - y0)
    const strip = read(y0, rows)
    let at = 0
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < rows; y++) {
        extractRow(strip, y, c)
        at += packBitsInto(rowBytes, width, scratch, stripBuffer, at)
      }
    }
    parts.push(stripBuffer.subarray(0, at))
  }

  return new Blob(parts, { type: 'image/vnd.adobe.photoshop' })
}

function packBitsInto(
  src: Uint8Array,
  length: number,
  scratch: Uint8Array,
  dst: Uint8Array,
  dstAt: number
): number {
  const n = packBitsRow(src, length, scratch)
  dst.set(scratch.subarray(0, n), dstAt)
  return n
}

/**
 * 기존 PSD 버퍼의 해상도 리소스(1005)를 지정 DPI로 교체·주입 —
 * ag-psd(레이어 PSD) 산출물에 350 DPI를 보장하는 후처리.
 */
export function patchPsdResolution(buffer: ArrayBuffer, dpi: number): ArrayBuffer {
  const src = new Uint8Array(buffer)
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength)
  const sig = String.fromCharCode(src[0]!, src[1]!, src[2]!, src[3]!)
  if (sig !== '8BPS') throw new Error('PSD 시그니처가 아닙니다')
  const colorModeLen = view.getUint32(26)
  const resourcesStart = 26 + 4 + colorModeLen
  const resourcesLen = view.getUint32(resourcesStart)
  const sectionEnd = resourcesStart + 4 + resourcesLen
  const resource = resolutionResource(dpi)

  const prefixEnd = resourcesStart + 4
  const parts: Uint8Array[] = [src.subarray(0, prefixEnd)]
  let resourceBytes = 0
  const pushResource = (block: Uint8Array): void => {
    parts.push(block)
    resourceBytes += block.length
  }
  let offset = prefixEnd
  let replaced = false
  while (offset + 12 <= sectionEnd) {
    const blockSig = String.fromCharCode(
      src[offset]!,
      src[offset + 1]!,
      src[offset + 2]!,
      src[offset + 3]!
    )
    if (blockSig !== '8BIM') break
    const id = view.getUint16(offset + 4)
    const nameLen = view.getUint16(offset + 6)
    const nameBytes = nameLen * 2
    const dataLen = view.getUint32(offset + 8 + nameBytes)
    const total = 8 + nameBytes + 4 + dataLen + (dataLen % 2)
    if (id === 1005) {
      pushResource(resource)
      replaced = true
    } else {
      pushResource(src.subarray(offset, offset + total))
    }
    offset += total
  }
  if (!replaced) pushResource(resource)
  parts.push(src.subarray(sectionEnd))

  const size = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  new DataView(out.buffer).setUint32(resourcesStart, resourceBytes)
  return out.buffer
}
