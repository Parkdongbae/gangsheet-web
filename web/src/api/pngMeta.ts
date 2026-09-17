/**
 * PNG 물리 DPI 메타데이터(pHYs 청크) 주입·파싱 — 순수 함수 (Node/Vitest·워커 공용).
 *
 * 데스크톱의 Python(Pillow dpi=350 저장)을 대체: 브라우저 canvas.toBlob PNG는
 * DPI 메타가 없으므로 IHDR 직후에 pHYs 청크를 삽입해 350 DPI를 기록한다.
 * 파싱은 core/imageMeta.ts의 extractImageDpi와 동일 규칙(round(ppm×0.0254)).
 */

const CRC_TABLE: Readonly<Uint32Array> = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) {
    crc = (CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const PPM_PER_DPI_NUMERATOR = 5000 // dpi → px/m: dpi × 5000/127 (1 inch = 0.0254 m)
const PPM_PER_DPI_DENOMINATOR = 127

export function dpiToPpm(dpi: number): number {
  return Math.round((dpi * PPM_PER_DPI_NUMERATOR) / PPM_PER_DPI_DENOMINATOR)
}

export function ppmToDpi(ppm: number): number {
  return Math.round(ppm * 0.0254)
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  )
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff
  target[offset + 1] = (value >>> 16) & 0xff
  target[offset + 2] = (value >>> 8) & 0xff
  target[offset + 3] = value & 0xff
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset + 4]!,
    bytes[offset + 5]!,
    bytes[offset + 6]!,
    bytes[offset + 7]!
  )
}

/** pHYs 청크 데이터(9바이트) — x/y 밀도(px/m) + 단위(1=미터) */
export function physChunkData(dpi: number): Uint8Array {
  const data = new Uint8Array(9)
  const ppm = dpiToPpm(dpi)
  writeU32(data, 0, ppm)
  writeU32(data, 4, ppm)
  data[8] = 1
  return data
}

/** 청크(길이+타입+데이터+CRC) 전체 직렬화 */
function encodeChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length)
  writeU32(chunk, 0, data.length)
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i)
  chunk.set(data, 8)
  writeU32(chunk, 8 + data.length, crc32(chunk, 4, 8 + data.length))
  return chunk
}

export interface PngMeta {
  width: number
  height: number
  dpi: number | null
}

/** PNG 바이너리 → 치수 + 물리 DPI (pHYs 없으면 null) */
export function parsePngMeta(bytes: Uint8Array): PngMeta {
  if (!isPng(bytes)) throw new Error('PNG 시그니처가 아닙니다')
  const meta: PngMeta = { width: readU32(bytes, 16), height: readU32(bytes, 20), dpi: null }
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset)
    const type = chunkType(bytes, offset)
    if (type === 'pHYs' && length >= 9) {
      const dataStart = offset + 8
      if (bytes[dataStart + 8] === 1) {
        meta.dpi = ppmToDpi(readU32(bytes, dataStart))
      }
      break
    }
    if (type === 'IDAT' || type === 'IEND') break
    offset = offset + 8 + length + 4
  }
  return meta
}

/**
 * PNG에 pHYs(350 DPI 등) 주입 — 기존 pHYs는 제거하고 IHDR 직후에 삽입.
 * @throws PNG 시그니처가 아니면
 */
export function injectPngDpi(png: ArrayBuffer, dpi: number): ArrayBuffer {
  const src = new Uint8Array(png)
  if (!isPng(src)) throw new Error('PNG 시그니처가 아닙니다')
  const phys = encodeChunk('pHYs', physChunkData(dpi))
  const parts: Uint8Array[] = [src.subarray(0, 8)]
  let offset = 8
  let inserted = false
  while (offset + 12 <= src.length) {
    const length = readU32(src, offset)
    const type = chunkType(src, offset)
    const total = 12 + length
    if (type === 'pHYs') {
      // 기존 pHYs는 건너뛴다(아래 IHDR 직후에 교체본 삽입)
    } else {
      parts.push(src.subarray(offset, offset + total))
      if (type === 'IHDR' && !inserted) {
        parts.push(phys)
        inserted = true
      }
    }
    if (type === 'IEND') break
    offset += total
  }
  if (!inserted) parts.push(phys)
  const size = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out.buffer
}
