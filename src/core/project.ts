/**
 * 프로젝트 파일(.dtf) 스키마·검증 — UI 라이브러리 의존 없는 순수 함수 (Vitest 선검증).
 * 메인 IPC(파일 입출력)와 렌더러(저장 페이로드 생성)가 공유하는 단일 계약.
 * dataUrl(프리뷰)은 저장하지 않는다 — filePath에서 로드 시 재생성한다(파일 경량화).
 */

import { PSD_MAX_PX } from './math'

export const PROJECT_EXTENSION = 'dtf'
export const PROJECT_FORMAT = 'dtf-gangsheet-project'
export const PROJECT_VERSION = 1

/** PlacedImage에서 dataUrl만 제외한 형태 — 저장 단위 */
export interface ProjectImage {
  id: string
  filePath: string
  widthPx: number
  heightPx: number
  x: number
  y: number
  rotation: number
  /** 선택적 그룹 식별자 — 같은 groupId를 공유하는 항목이 하나의 그룹 (v1 하위 호환) */
  groupId?: string
  /** 잠금 — 이동·삭제 등 편집 보호 (v1 하위 호환, 미저장 시 false) */
  locked?: boolean
}

/** 웹 빌드가 저장하는 내장 원본 — 브라우저는 디스크 경로가 없어 파일에 싣는다.
 *  데스크톱 저장은 기존대로 링크 기반(생략) — 로드 측만 양쪽 모두 지원한다. */
export interface ProjectAsset {
  /** 이 에셋을 참조하는 ProjectImage.filePath와 동일한 키 */
  path: string
  name: string
  type: string
  /** 원본 바이너리의 Base64 */
  dataBase64: string
}

export interface ProjectDocument {
  widthPx: number
  heightPx: number
}

export interface ProjectData {
  format: string
  version: number
  document: ProjectDocument
  images: ProjectImage[]
  /** 내장 원본 — 웹 빌드 저장 시에만 존재 (v1 선택 필드, 구형 리더는 제거하고 연다) */
  assets?: ProjectAsset[]
}

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectFormatError'
  }
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const requirePositiveInt = (
  container: Record<string, unknown>,
  key: string,
  label: string
): number => {
  const value = container[key]
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value <= 0) {
    throw new ProjectFormatError(`${label} must be a positive integer, got ${String(value)}`)
  }
  return value
}

/** 항목 치수 — 리사이즈·비율 연산 결과는 소수(예: 1206.99…px)가 정상이므로 정수 강제 금지 */
const requirePositive = (
  container: Record<string, unknown>,
  key: string,
  label: string
): number => {
  const value = container[key]
  if (!isFiniteNumber(value) || value <= 0) {
    throw new ProjectFormatError(`${label} must be a positive number, got ${String(value)}`)
  }
  return value
}

const requireFinite = (container: Record<string, unknown>, key: string, label: string): number => {
  const value = container[key]
  if (!isFiniteNumber(value)) {
    throw new ProjectFormatError(`${label} must be a finite number, got ${String(value)}`)
  }
  return value
}

/**
 * 외부 입력(.dtf 파일·렌더러 페이로드) → 정규화 ProjectData — 미지 필드 제거.
 * 저장 직전 자체 검증에도 쓰여 손상 파일 생성을 원천 차단한다.
 *
 * @throws ProjectFormatError 스키마 위반·치수 한계(PSD 30,000px) 초과
 */
export function validateProjectData(raw: unknown): ProjectData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProjectFormatError('project must be an object')
  }
  const root = raw as Record<string, unknown>
  if (root.format !== PROJECT_FORMAT) {
    throw new ProjectFormatError(`unsupported format: ${String(root.format)}`)
  }
  if (root.version !== PROJECT_VERSION) {
    // 버전 불일치 — 마이그레이션 지점이 생기면 여기서 변환한다
    throw new ProjectFormatError(`unsupported version: ${String(root.version)}`)
  }
  const docRaw = root.document
  if (typeof docRaw !== 'object' || docRaw === null || Array.isArray(docRaw)) {
    throw new ProjectFormatError('document must be an object')
  }
  const doc = docRaw as Record<string, unknown>
  const widthPx = requirePositiveInt(doc, 'widthPx', 'document.widthPx')
  const heightPx = requirePositiveInt(doc, 'heightPx', 'document.heightPx')
  if (widthPx > PSD_MAX_PX || heightPx > PSD_MAX_PX) {
    throw new ProjectFormatError(`document exceeds PSD ${PSD_MAX_PX}px limit`)
  }
  if (!Array.isArray(root.images)) {
    throw new ProjectFormatError('images must be an array')
  }
  const images = root.images.map((entry, index) => {
    const label = `images[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ProjectFormatError(`${label} must be an object`)
    }
    const item = entry as Record<string, unknown>
    if (typeof item.id !== 'string' || item.id.length === 0) {
      throw new ProjectFormatError(`${label}.id must be a non-empty string`)
    }
    if (typeof item.filePath !== 'string' || item.filePath.length === 0) {
      throw new ProjectFormatError(`${label}.filePath must be a non-empty string`)
    }
    return {
      id: item.id,
      filePath: item.filePath,
      widthPx: requirePositive(item, 'widthPx', `${label}.widthPx`),
      heightPx: requirePositive(item, 'heightPx', `${label}.heightPx`),
      x: requireFinite(item, 'x', `${label}.x`),
      y: requireFinite(item, 'y', `${label}.y`),
      rotation: requireFinite(item, 'rotation', `${label}.rotation`),
      groupId:
        typeof item.groupId === 'string' && item.groupId.length > 0 ? item.groupId : undefined,
      locked: item.locked === true ? true : undefined
    }
  })
  const assets = validateProjectAssets(root.assets)
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    document: { widthPx, heightPx },
    images,
    ...(assets !== undefined ? { assets } : {})
  }
}

/** 선택적 내장 에셋 검증 — 같은 path 중복은 첫 항목으로 정규화, 빈 배열은 undefined */
function validateProjectAssets(raw: unknown): ProjectAsset[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    throw new ProjectFormatError('assets must be an array')
  }
  if (raw.length === 0) return undefined
  const byPath = new Map<string, ProjectAsset>()
  raw.forEach((entry, index) => {
    const label = `assets[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ProjectFormatError(`${label} must be an object`)
    }
    const item = entry as Record<string, unknown>
    if (typeof item.path !== 'string' || item.path.length === 0) {
      throw new ProjectFormatError(`${label}.path must be a non-empty string`)
    }
    if (typeof item.name !== 'string' || item.name.length === 0) {
      throw new ProjectFormatError(`${label}.name must be a non-empty string`)
    }
    if (typeof item.type !== 'string' || item.type.length === 0) {
      throw new ProjectFormatError(`${label}.type must be a non-empty string`)
    }
    if (typeof item.dataBase64 !== 'string' || item.dataBase64.length === 0) {
      throw new ProjectFormatError(`${label}.dataBase64 must be a non-empty string`)
    }
    const asset: ProjectAsset = {
      path: item.path,
      name: item.name,
      type: item.type,
      dataBase64: item.dataBase64
    }
    if (!byPath.has(asset.path)) byPath.set(asset.path, asset)
  })
  return [...byPath.values()]
}
