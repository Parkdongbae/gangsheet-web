/**
 * AI 배경 제거 클라이언트 — 워커 수명·요청 큐·진행 알림(%·남은 시간)을 관리한다.
 * 워커는 첫 요청 때 생성하고 모델 세션을 재사용하기 위해 계속 살려 둔다.
 */
import type { RemoveBgProgress } from '@shared/ipc'
import type { BgWorkerRequest, BgWorkerResponse } from './bgWorker'
import {
  DEFAULT_PROFILES,
  estimateProgress,
  isFirstRunStage,
  updateProfile,
  type BgBackend,
  type BgStage,
  type BgTimingProfile
} from './progress'

const PROFILE_KEY = 'dtf:bg-timing'
/** 진행 표시 갱신 주기 — 중간값이 없는 단계에서도 %와 남은 시간이 계속 움직이게 한다 */
const TICK_MS = 250
/** 워커가 이 시간 동안 아무 소식이 없으면 멈춘 것으로 보고 정리한다 */
const STALL_TIMEOUT_MS = 240_000

interface Pending {
  resolve: (blob: Blob) => void
  reject: (err: Error) => void
  onProgress: (progress: RemoveBgProgress) => void
  megapixels: number
  startedAt: number
  stage: BgStage | null
  stageAt: number
  ratio: number | undefined
  backend: BgBackend
  sawFirstRunStage: boolean
  lastPercent: number
  lastMessageAt: number
  timer: ReturnType<typeof setInterval>
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function loadProfiles(): Record<BgBackend, BgTimingProfile> {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Record<BgBackend, Partial<BgTimingProfile>>>
      return {
        webgpu: { ...DEFAULT_PROFILES.webgpu, ...saved.webgpu },
        wasm: { ...DEFAULT_PROFILES.wasm, ...saved.wasm }
      }
    }
  } catch {
    /* 손상된 값은 무시하고 기본값 사용 */
  }
  return { webgpu: { ...DEFAULT_PROFILES.webgpu }, wasm: { ...DEFAULT_PROFILES.wasm } }
}

let profiles = loadProfiles()

function saveProfiles(): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles))
  } catch {
    /* 저장 실패 시 이번 세션에만 적용 */
  }
}

function finish(id: number): Pending | undefined {
  const entry = pending.get(id)
  if (!entry) return undefined
  clearInterval(entry.timer)
  pending.delete(id)
  return entry
}

function failAll(message: string): void {
  for (const id of [...pending.keys()]) finish(id)?.reject(new Error(message))
  worker?.terminate()
  worker = null
}

function emit(entry: Pending): void {
  if (!entry.stage) return
  const now = performance.now()
  const estimate = estimateProgress({
    stage: entry.stage,
    ...(entry.ratio !== undefined ? { ratio: entry.ratio } : {}),
    elapsedMs: now - entry.startedAt,
    stageElapsedMs: now - entry.stageAt,
    megapixels: entry.megapixels,
    profile: profiles[entry.backend]
  })
  // 예측이 흔들려도 화면의 %는 뒤로 가지 않게 한다
  entry.lastPercent = Math.max(entry.lastPercent, estimate.percent)
  entry.onProgress({
    stage: entry.stage,
    ...(entry.ratio !== undefined ? { ratio: entry.ratio } : {}),
    percent: entry.lastPercent,
    ...(estimate.etaSeconds !== undefined ? { etaSeconds: estimate.etaSeconds } : {})
  })
}

/**
 * 문제 해결용 스위치 — 그래픽 드라이버 문제로 결과가 깨질 때 개발자 도구에서
 * localStorage.setItem('dtf:bg-backend', 'wasm') 후 새로고침하면 CPU(WASM)로만 실행한다.
 */
function prefersWasm(): boolean {
  try {
    return localStorage.getItem('dtf:bg-backend') === 'wasm'
  } catch {
    return false
  }
}

function getWorker(): Worker {
  if (worker) return worker
  const created = new Worker(new URL('./bgWorker.ts', import.meta.url), { type: 'module' })
  created.onmessage = (event: MessageEvent<BgWorkerResponse>): void => {
    const data = event.data
    const entry = pending.get(data.id)
    if (!entry) return
    entry.lastMessageAt = performance.now()
    if (data.type === 'progress') {
      if (data.backend) entry.backend = data.backend
      if (data.stage !== entry.stage) {
        entry.stage = data.stage
        entry.stageAt = performance.now()
        if (isFirstRunStage(data.stage)) entry.sawFirstRunStage = true
      }
      entry.ratio = data.stage === 'download' ? data.ratio : undefined
      emit(entry)
      return
    }
    finish(data.id)
    if (data.type === 'done') {
      console.info(`[bg] ${data.backend} ${data.ms}ms`)
      profiles = {
        ...profiles,
        [data.backend]: updateProfile(
          profiles[data.backend],
          data.timings,
          entry.megapixels,
          entry.sawFirstRunStage
        )
      }
      saveProfiles()
      entry.resolve(data.blob)
    } else {
      entry.reject(new Error(data.message))
    }
  }
  created.onerror = (event): void => {
    failAll(`배경 제거 엔진을 시작하지 못했습니다${event.message ? `: ${event.message}` : ''}`)
  }
  worker = created
  return created
}

/** 디코딩된 원본 비트맵 → 배경이 투명한 RGBA PNG (원본 치수 유지) */
export function removeBackgroundAi(
  bitmap: ImageBitmap,
  onProgress: (progress: RemoveBgProgress) => void
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const id = nextId++
    const now = performance.now()
    const entry: Pending = {
      resolve,
      reject,
      onProgress,
      megapixels: (bitmap.width * bitmap.height) / 1_000_000,
      startedAt: now,
      stage: null,
      stageAt: now,
      ratio: undefined,
      backend: prefersWasm() ? 'wasm' : 'webgpu',
      sawFirstRunStage: false,
      lastPercent: 0,
      lastMessageAt: now,
      timer: setInterval(() => {
        const live = pending.get(id)
        if (!live) return
        if (performance.now() - live.lastMessageAt > STALL_TIMEOUT_MS) {
          failAll(
            'AI 배경 제거가 응답하지 않아 중단했습니다. 다시 시도하거나 "단색 배경" 방식을 사용해 보세요.'
          )
          return
        }
        emit(live)
      }, TICK_MS)
    }
    pending.set(id, entry)
    const message: BgWorkerRequest = { type: 'run', id, bitmap, forceWasm: prefersWasm() }
    try {
      getWorker().postMessage(message, [bitmap])
    } catch (err) {
      finish(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
