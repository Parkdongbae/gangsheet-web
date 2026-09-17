/**
 * 웹 자동저장 — 데스크톱의 ".dtf 수동 저장 + 디스크 상주" 대응 웹 규칙.
 *
 * ProxyCanvas가 씬 변경마다 dispatch하는 dtf:scene-committed 이벤트(Electron에서는
 * 수신자 없는 inert 훅)를 받아 1.5초 디바운스 후 ProjectData(dataUrl 제거)를
 * IndexedDB kv에 기록한다. 부팅 시 기록이 있으면 복원 여부를 묻고 기존
 * dtf:open-project E2E 이벤트 경로로 되살린다(이미지는 vfs가 IndexedDB에서 복원).
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
import { kvGet, kvSet } from './vfs'

const AUTOSAVE_KEY = 'autosave-project'
const AUTOSAVE_PATH = 'web-autosave://last'
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

/** 앱 마운트 직후 호출 — 이전 자동저장이 있으면 복원 여부 확인 후 열기 이벤트 발행 */
export async function bootAutosaveRestore(): Promise<void> {
  const saved = await kvGet<{ data: ProjectData; savedAt: number }>(AUTOSAVE_KEY)
  if (!saved?.data || !Array.isArray(saved.data.images) || saved.data.images.length === 0) return
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  if (
    !window.confirm(
      '이전 웹 작업 내용이 있습니다. 복원하시겠습니까?\n(취소하면 새 문서 화면으로 시작합니다)'
    )
  ) {
    return
  }
  window.dispatchEvent(new CustomEvent('dtf:open-project', { detail: AUTOSAVE_PATH }))
}
