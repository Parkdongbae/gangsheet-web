/**
 * 내보내기 매니페스트 빌더 (S6 세션 1) — Electron↔Python 사이드카 IPC 계약.
 *
 * STDIO_GUIDE 철칙: 사이드카 stdio로는 이미지 바이너리·Base64를 절대 보내지
 * 않는다. 파일 경로 + cm 좌표만 담은 Light JSON Manifest를 전달하고,
 * Python(renderer.py)이 디스크에서 원본을 직접 로드해 CMYK PSD를 합성한다.
 *
 * 에디터 내부 상태(PlacedImage[] = 350 DPI 절대 px)를 cm로 환산해 담는다.
 * px↔cm 왕복은 float64 정밀도로 무손실임을 테스트가 보장한다(±0.5px 미만).
 */

/** 사이드카로 전달되는 매니페스트 항목 — src 외에는 전부 실물 단위(cm) */
/** psd = CMYK 레이어 보존(기본) · png = 알파 보존 검수용(F9) · pdf = 인쇄 검수 문서 */
export type ExportFormat = 'psd' | 'png' | 'pdf'

export interface ExportManifestItem {
  src: string
  x_cm: number
  y_cm: number
  width_cm: number
  height_cm: number
  rotation: number
}

export interface ExportManifestCanvas {
  width_cm: number
  height_m: number
  dpi: number
}

/** Python renderer.parse_manifest와 1:1 대응하는 스키마 (서버/클라 계약) */
export interface ExportManifest {
  output_path: string
  canvas: ExportManifestCanvas
  items: ExportManifestItem[]
  format?: ExportFormat
  flatten?: boolean
}

/** 매니페스트 빌드 입력 — PlacedImage를 구조적으로 만족(컴포넌트 의존 없음) */
export interface ExportableItem {
  filePath: string
  x: number
  y: number
  widthPx: number
  heightPx: number
  rotation: number
}

export interface ExportManifestParams {
  outputPath: string
  widthPx: number
  heightPx: number
  items: readonly ExportableItem[]
  /** 기본 350 — 인쇄 해상도 고정값(CLAUDE.md §1) */
  dpi?: number
  format?: ExportFormat
  /** true = PSD 단일 병합 인쇄 레이어 (F8) */
  flatten?: boolean
}

export const CM_PER_INCH = 2.54
export const DEFAULT_DPI = 350

export function pxToCm(px: number, dpi: number = DEFAULT_DPI): number {
  return (px * CM_PER_INCH) / dpi
}

/** cm → px(Math.round) — Python renderer.cm_to_px와 동일 규칙, 왕복 검증용 */
export function cmToPx(cm: number, dpi: number = DEFAULT_DPI): number {
  return Math.round((cm / CM_PER_INCH) * dpi)
}

export function buildExportManifest(params: ExportManifestParams): ExportManifest {
  const dpi = params.dpi ?? DEFAULT_DPI
  const manifest: ExportManifest = {
    output_path: params.outputPath,
    canvas: {
      width_cm: pxToCm(params.widthPx, dpi),
      height_m: pxToCm(params.heightPx, dpi) / 100,
      dpi
    },
    items: params.items.map((item) => ({
      src: item.filePath,
      x_cm: pxToCm(item.x, dpi),
      y_cm: pxToCm(item.y, dpi),
      width_cm: pxToCm(item.widthPx, dpi),
      height_cm: pxToCm(item.heightPx, dpi),
      rotation: item.rotation
    }))
  }
  // 기본값(psd·false)은 생략 — 직렬화 최소화(바이너리 유출 방지 2KB 상한 회귀 대상)
  if (params.format === 'png' || params.format === 'pdf') manifest.format = params.format
  if (params.flatten) manifest.flatten = true
  return manifest
}
