/**
 * AI 업스케일 클라이언트 — 워커 수명·취소·진행 알림. 한 번에 한 작업만 실행한다.
 * 취소는 워커를 종료하는 방식(추론은 중간에 끊을 수 없음)이라 다음 실행 때 세션을 다시 만든다.
 */
import type { UpEngine, UpWorkerRequest, UpWorkerResponse } from './upWorker'

export interface AiUpscaleProgress {
  stage: 'download' | 'init' | 'tile' | 'encode'
  /** download: 0..1 */
  ratio?: number
  current?: number
  total?: number
}

export const AI_UPSCALE_CANCELLED = '업스케일이 취소되었습니다'

let worker: Worker | null = null
let nextId = 1
let active: { id: number; reject: (err: Error) => void } | null = null

function dispose(): void {
  worker?.terminate()
  worker = null
}

function prefersWasm(): boolean {
  try {
    return localStorage.getItem('dtf:bg-backend') === 'wasm'
  } catch {
    return false
  }
}

export function cancelAiUpscale(): void {
  if (!active) return
  const { reject } = active
  active = null
  dispose()
  reject(new Error(AI_UPSCALE_CANCELLED))
}

/** bitmap을 x4씩 passes번 확대한 비트맵을 돌려준다 */
export function upscaleWithAi(
  bitmap: ImageBitmap,
  engine: UpEngine,
  passes: number,
  onProgress: (progress: AiUpscaleProgress) => void
): Promise<ImageBitmap> {
  if (active) return Promise.reject(new Error('다른 업스케일이 진행 중입니다'))
  return new Promise<ImageBitmap>((resolve, reject) => {
    const id = nextId++
    active = { id, reject }
    worker ??= new Worker(new URL('./upWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<UpWorkerResponse>): void => {
      const data = event.data
      if (!active || data.id !== active.id) return
      if (data.type === 'progress') {
        if ('current' in data) {
          onProgress({ stage: data.stage, current: data.current, total: data.total })
        } else {
          onProgress({
            stage: data.stage,
            ...(data.ratio !== undefined ? { ratio: data.ratio } : {})
          })
        }
        return
      }
      active = null
      if (data.type === 'done') {
        console.info(`[up] ${data.backend} ${data.ms}ms`)
        resolve(data.bitmap)
      } else {
        reject(new Error(data.message))
      }
    }
    worker.onerror = (event): void => {
      if (!active) return
      active = null
      dispose()
      reject(new Error(`업스케일 엔진 오류${event.message ? `: ${event.message}` : ''}`))
    }
    const message: UpWorkerRequest = {
      type: 'run',
      id,
      bitmap,
      engine,
      passes,
      forceWasm: prefersWasm()
    }
    worker.postMessage(message, [bitmap])
  })
}
