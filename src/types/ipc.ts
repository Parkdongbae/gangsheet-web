/** 공유 IPC 계약 (CLAUDE.md §2.1 src/types) — 메인·프리로드·렌더러가 함께 참조.
 *
 * 원칙: 렌더러→메인 사이드카에 바이너리(ArrayBuffer)를 전송하지 않고
 * 파일 절대 경로를 주고받는다. 프리뷰는 메인 프로세스에서 ≤2,048px로
 * 리사이즈한 PNG dataURL로 전달한다 (S4 설계 패턴 #1·#2).
 */
import type { ProjectData } from '../core/project'

/** 원본 이미지의 물리 DPI 메타데이터 — PNG pHYs/JPEG JFIF에서 추출 (없으면 undefined) */
export interface ImageDpiMeta {
  dpi: number
}

/** 이미지 임포트 결과 — 원본 크기는 350 DPI 절대 px 기준 */
export interface ImportedImage {
  /** ≤2,048px PNG 프리뷰 (알파 보존) — 캔버스 표시 전용 */
  dataUrl: string
  /** 원본 가로 (350 DPI 절대 px) — 씬 배치 크기로 사용 */
  widthPx: number
  /** 원본 세로 (350 DPI 절대 px) */
  heightPx: number
  previewWidthPx: number
  previewHeightPx: number
  /** 원본 메타데이터 DPI — 물리 치수 보존 배치(실제 cm 크기 유지)에 사용 */
  dpi?: number
}

/** .dtf 프로젝트 열기 결과 — 데이터 + 열린 파일 경로(문서 이름 표시용) */
export interface OpenedProject {
  data: ProjectData
  filePath: string
}

/** 배경 제거 결과 — 처리된 32-bit RGBA PNG가 새 원본이 된다 (치수는 입력과 동일) */
export interface RemoveBgImage extends ImportedImage {
  /** 배경 제거된 RGBA PNG 절대 경로 — 이후 내보내기·재편집의 원본 */
  filePath: string
}

/** 자동 트림 결과 — 잘린 PNG가 새 원본이 된다 (no-op이면 원본 경로 그대로) */
export interface TrimmedImage extends ImportedImage {
  /** 트림된 RGBA PNG 절대 경로 — no-op이면 입력 경로와 동일 */
  filePath: string
  /** 실제로 잘렸는가 — 완전 투명·여백 없음·알파 없는 포맷은 false */
  trimmed: boolean
}

/** 사이드카 remove_bg 결과 — 경로·메타데이터만 (바이너리 반환 금지) */
export interface RemoveBgSidecarResult {
  output_path: string
  width_px: number
  height_px: number
}

/** 사이드카 auto_trim 결과 — 경로·메타데이터만 (바이너리 반환 금지) */
export interface AutoTrimSidecarResult {
  output_path: string
  width_px: number
  height_px: number
  trimmed: boolean
}

/** 업스케일 요청 옵션 — 렌더러 다이얼로그 입력값. 계획 수립(체인·가드레일)은
 *  메인이 공유 Plan Builder(src/core/upscaler/plan.ts)로 수행한다. */
export interface UpscaleOptions {
  unit: 'cm' | 'px' | 'scale'
  widthCm?: number
  heightCm?: number
  widthPx?: number
  heightPx?: number
  scale?: number
  dpi: number
  stepStrategy: 'AUTO' | 'STEP_2X' | 'STEP_3X' | 'STEP_5X' | 'DIRECT'
  fitMode: 'KEEP_RATIO' | 'COVER' | 'CONTAIN' | 'STRETCH'
  format: 'png' | 'jpeg' | 'webp'
  quality?: number
  embedDpiMetadata?: boolean
  sharpening?: number
  denoiseLevel?: 0 | 1 | 2
  /** AI 엔진 — general(사진용 RealESRGAN x4) | anime(일러스트용 AnimeVideo-v3 x4) */
  engine?: 'general' | 'anime'
}

/** 사이드카 upscale 요청 페이로드 — STDIO 경로 계약 (UPSCALER.MD v2.0 §5).
 *  skip_steps > 0이면 resume_from_path 체크포인트에서 나머지 스텝만 실행(§5.3). */
export interface UpscaleSidecarRequest {
  input_path: string
  output_path: string
  chain: number[]
  target_w: number
  target_h: number
  fit_mode: UpscaleOptions['fitMode']
  crop: { x: number; y: number; w: number; h: number } | null
  format: UpscaleOptions['format']
  quality: number
  dpi: number
  embed_dpi: boolean
  sharpen: number
  denoise: number
  model: string
  checkpoint_dir: string | null
  resume_from_path: string | null
  skip_steps: number
}

/** 사이드카 upscale 결과 — 경로·메타데이터만 */
export interface UpscaleSidecarResult {
  output_path: string
  width_px: number
  height_px: number
  duration_ms: number
  steps: Array<{ scale: number; out_w: number; out_h: number; ms: number }>
}

/** 사이드카 upscale 진행 알림 와이어 형식 — 메인이 UpscaleProgress로 변환·가중치 첨부 */
export interface UpscaleSidecarProgress {
  stage: 'step' | 'tile' | 'encode'
  step: number
  total_steps: number
  current: number
  total: number
}

/** 업스케일 진행 알림 — stage별 세부 진행(current/total)과 가중 전체 진행률 */
export interface UpscaleProgress {
  stage: 'step' | 'tile' | 'encode'
  step: number
  totalSteps: number
  current: number
  total: number
  /** 픽셀 가중치 기반 전체 진행률 0..1 (§4.5) — 메인이 계산해 첨부 */
  overallProgress: number
}

/** 업스케일 결과 — 처리된 이미지가 새 원본이 된다 (removeBg 치환 정책과 동일) */
export interface UpscaledImage extends ImportedImage {
  filePath: string
  totalScale: number
  steps: Array<{ step: number; scale: number; outW: number; outH: number; ms: number }>
  elapsedMs: number
}

/** 재개 가능한 중단 실행 — 취소·실패 시 완료 스텝이 남아 있을 때 제공 (§5.3) */
export interface UpscaleResumeInfo {
  filePath: string
  skipSteps: number
  totalSteps: number
}

/** 예상 시간 캘리브레이션 — AI 실행 실적 기반 ms/MP (§4.6). 샘플 없으면 null */
export interface UpscaleCalibration {
  msPerMpx: number | null
}

/** 이미지 헤더 정보 — 업스케일 예상 패널용 (원본 파일 px + 물리 DPI + 파일 크기) */
export interface ImageInfo {
  width: number
  height: number
  bytes: number
  dpi?: number
}

import type { ExportFormat, ExportManifest } from '../workers/exportManifest'

/** 사이드카 render 진행 알림 — stage "items"=항목 렌더, "write"=파일 저장 */
export interface ExportProgress {
  stage: 'items' | 'write'
  current: number
  total: number
}

/** 사이드카 render 결과 — 경로·메타데이터만 (바이너리 반환 금지) */
export interface ExportResult {
  output_path: string
  width_px: number
  height_px: number
  layer_count: number
  duration_ms: number
}

export type { ExportFormat, ExportManifest }

/** 프리로드가 렌더러에 노출하는 에디터 API */
export interface DtfApi {
  /** 파일 대화상자(다중 선택) — 취소 시 null */
  openImages(): Promise<string[] | null>
  /** 원본 경로만 전달해 임포트 — 프리뷰 dataURL + 원본 px 반환 */
  importImage(filePath: string): Promise<ImportedImage>
  /** 배경 제거(rembg 사이드카) — 처리된 RGBA PNG 경로 + 프리뷰 반환 (v2) */
  removeBackground(filePath: string): Promise<RemoveBgImage>
  /** 투명 여백 자동 제거(사이드카 auto_trim) — 알파 바운딩 박스 크롭 PNG 경로 + 프리뷰 반환 */
  autoTrimImage(filePath: string): Promise<TrimmedImage>
  /** 이미지 헤더 치수·DPI — 업스케일 예상 패널용 (원본 파일 px 기준) */
  imageInfo(filePath: string): Promise<ImageInfo>
  /** 단계별 AI 업스케일(사이드카) — DPI 메타 포함 결과 경로 + 프리뷰 반환. 진행은 onUpscaleProgress로 수신 */
  upscaleImage(filePath: string, options: UpscaleOptions): Promise<UpscaledImage>
  /** 중단된 업스케일 이어하기 — 마지막 완료 단계 체크포인트부터 나머지 스텝 실행 */
  resumeUpscale(): Promise<UpscaledImage>
  /** 재개 가능한 중단 작업 조회 — 없으면 null */
  getUpscaleResumable(): Promise<UpscaleResumeInfo | null>
  /** 예상 시간 캘리브레이션(ms/MP) 조회 — 첫 AI 실행 전에는 null */
  getUpscaleCalibration(): Promise<UpscaleCalibration>
  /** 진행 중 업스케일 취소 — 사이드카 재시작으로 안전 중단(≤1초) */
  cancelUpscale(): Promise<void>
  /** 업스케일 진행 알림 구독 — 반환 함수 호출로 구독 해제 */
  onUpscaleProgress(listener: (progress: UpscaleProgress) => void): () => void
  /** 드래그앤드롭 File → 절대 경로 — Electron 32+ 에서 File.path 제거의 공식 대체 */
  getPathForFile(file: File): string
  /** 내보내기 저장 대화상자 — 포맷별 확장자 필터, 취소 시 null */
  exportSaveDialog(format: ExportFormat): Promise<string | null>
  /** 매니페스트를 사이드카로 렌더 — 진행률은 onExportProgress로 수신 */
  exportDocument(manifest: ExportManifest): Promise<ExportResult>
  /** 진행 중 내보내기 취소 — 다음 내보내기부터 사이드카 자동 재시작 */
  cancelExport(): Promise<void>
  /** 내보내기 진행 알림 구독 — 반환 함수 호출로 구독 해제 */
  onExportProgress(listener: (progress: ExportProgress) => void): () => void
  /** 번들된 가이드 PDF를 시스템 기본 뷰어로 열기 */
  openGuidePdf(): Promise<void>
  /** 번들된 사용자 메뉴얼 PDF를 시스템 기본 뷰어로 열기 */
  openManualPdf(): Promise<void>
  /** 번들된 오픈소스 라이선스 고지(THIRD_PARTY_LICENSES.txt)를 기본 뷰어로 열기 */
  openLicenses(): Promise<void>
  /** 번들된 Adobe Express 배경 제거 가이드 PDF를 기본 뷰어로 열기 */
  openBgGuide(): Promise<void>
  /** 현재 작업을 .dtf 프로젝트로 저장 — 저장 경로 반환, 취소 시 null */
  saveProject(data: ProjectData, path?: string): Promise<string | null>
  /** .dtf 프로젝트 열기 — 데이터 + 파일 경로 반환, 취소 시 null */
  openProject(path?: string): Promise<OpenedProject | null>
  /** 내보내기 PSD 색상 모드 — 미정의 시 데스크톱 기본(CMYK). 웹 구현은 RGB로 명시 */
  readonly exportColorMode?: 'CMYK' | 'RGB'
  /** AI 업스케일 엔진 사용 여부 — 미정의 시 데스크톱 기본(true). 웹 구현은 리샘플만(false) */
  readonly aiUpscale?: boolean
}
