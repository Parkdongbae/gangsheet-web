/**
 * AI 배경 제거 클라이언트 — 워커 수명·요청 큐·진행 알림을 관리한다.
 * 워커는 첫 요청 때 생성하고 모델 세션을 재사용하기 위해 계속 살려 둔다.
 */
import type { RemoveBgProgress } from '@shared/ipc'
import type { BgWorkerRequest, BgWorkerResponse } from './bgWorker'

interface Pending {
  resolve: (blob: Blob) => void
  reject: (err: Error) => void
  onProgress: (progress: RemoveBgProgress) => void
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function failAll(message: string): void {
  for (const entry of pending.values()) entry.reject(new Error(message))
  pending.clear()
  worker?.terminate()
  worker = null
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
    if (data.type === 'progress') {
      entry.onProgress({
        stage: data.stage,
        ...(data.ratio !== undefined ? { ratio: data.ratio } : {})
      })
      return
    }
    pending.delete(data.id)
    if (data.type === 'done') {
      console.info(`[bg] ${data.backend} ${data.ms}ms`)
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
    pending.set(id, { resolve, reject, onProgress })
    const message: BgWorkerRequest = { type: 'run', id, bitmap, forceWasm: prefersWasm() }
    try {
      getWorker().postMessage(message, [bitmap])
    } catch (err) {
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
