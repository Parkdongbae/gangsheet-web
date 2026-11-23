/**
 * 웹 자동저장 — 데스크톱의 ".dtf 수동 저장 + 디스크 상주" 대응 웹 규칙.
 *
 * ProxyCanvas가 씬 변경마다 dispatch하는 dtf:scene-committed 이벤트(Electron에서는
 * 수신자 없는 inert 훅)를 받아 1.5초 디바운스 후 ProjectData(dataUrl 제거)를
 * IndexedDB kv에 기록한다. 복원은 시작 화면의 "이어서 작업하기" 카드가
 * window.api.getResumableSession()으로 조회해 openProject로 연다(이미지는 vfs가
 * IndexedDB에서 복원).
 *
 * 빈 씬(이미지 0개)은 기록하지 않는다 — 새 문서 화면 진입이 직전 자동저장을
 * 덮어쓰는 사고를 막기 위해서다.
 */
import {
  PROJECT_FORMAT,
  PROJECT_VERSION,
  validateProjectData,
  type ProjectData
} from '@core/project'
import { kvSet } from './vfs'

const AUTOSAVE_KEY = 'autosave-project'
const DEBOUNCE_MS = 1500

export interface SceneCommittedDetail {
  widthPx: number
  heightPx: number
  images: ReadonlyArray<{
    id: string
    filePath: string
    widthPx: number
    heightPx: number
    x: number
    y: number
    rotation: number
    groupId?: string
    locked?: boolean
  }>
}

let timer: ReturnType<typeof setTimeout> | null = null
let pending: ProjectData | null = null

function toProjectData(detail: SceneCommittedDetail): ProjectData {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    document: { widthPx: detail.widthPx, heightPx: detail.heightPx },
    images: detail.images.map(
      ({ id, filePath, widthPx, heightPx, x, y, rotation, groupId, locked }) => ({
        id,
        filePath,
        widthPx,
        heightPx,
        x,
        y,
        rotation,
        ...(groupId !== undefined ? { groupId } : {}),
        ...(locked === true ? { locked: true } : {})
      })
    )
  }
}

function scheduleFlush(detail: SceneCommittedDetail): void {
  if (detail.images.length === 0) return
  pending = toProjectData(detail)
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    const data = pending
    pending = null
    if (!data) return
    try {
      const normalized = validateProjectData(data)
      void kvSet(AUTOSAVE_KEY, { data: normalized, savedAt: Date.now() })
    } catch {
      // 비정상 씬(스키마 위반)은 자동저장을 건너뛴다 — 저장 실패보다 안전
    }
  }, DEBOUNCE_MS)
}

export function installAutosave(): void {
  window.addEventListener('dtf:scene-committed', (event) => {
    const detail = (event as CustomEvent<SceneCommittedDetail>).detail
    if (detail && typeof detail.widthPx === 'number' && Array.isArray(detail.images)) {
      scheduleFlush(detail)
    }
  })
}
