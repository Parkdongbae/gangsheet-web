/**
 * 브라우저 AI 추론 공통 런타임(워커 전용) — onnxruntime-web 설정·가중치 다운로드/캐시·
 * 실행 장치 선택. 배경 제거(bgRemoval)와 업스케일(upscale) 워커가 함께 쓴다.
 *
 * 주의(2026-11-23 결함): onnxruntime-web의 번들판은 스레드 워커를 "자기 자신의 스크립트
 * URL"로 다시 띄운다. Vite가 이 모듈을 우리 워커 청크에 합치면 그 URL이 우리 워커가 되어
 * 스레드가 영영 준비되지 않고 세션 생성이 멈춘다(개발 서버에서는 재현되지 않음).
 * 그래서 런타임 글루(.mjs)와 .wasm을 별도 자산으로 내보내 wasmPaths로 명시한다.
 */
import * as ort from 'onnxruntime-web/webgpu'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'

export { ort }

const CACHE_NAME = 'dtf-bg-models-v1'

export interface ModelSource {
  url: string
  /** content-length를 읽지 못할 때 진행률 계산에 쓰는 대략적인 크기 */
  bytes: number
}

let configured = false

export function configureOrt(): void {
  if (configured) return
  configured = true
  ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl }
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
    : 1
}

/** 가중치 다운로드 — Cache Storage에 있으면 즉시 반환, 없으면 내려받으며 진행률 통지 */
export async function fetchModel(
  model: ModelSource,
  onRatio: (ratio: number) => void
): Promise<ArrayBuffer> {
  let cache: Cache | null = null
  try {
    cache = await caches.open(CACHE_NAME)
    const hit = await cache.match(model.url)
    if (hit) return await hit.arrayBuffer()
  } catch {
    cache = null // 시크릿 모드 등 — 캐시 없이 진행
  }

  const res = await fetch(model.url, { mode: 'cors', credentials: 'omit' })
  if (!res.ok || !res.body) throw new Error(`AI 모델 다운로드 실패 (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length')) || model.bytes
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    onRatio(Math.min(0.999, loaded / total))
  }
  const buffer = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (cache) {
    try {
      await cache.put(
        model.url,
        new Response(buffer, { headers: { 'content-type': 'application/octet-stream' } })
      )
    } catch {
      // 저장 공간 부족 — 다음 방문 때 다시 내려받는다
    }
  }
  return buffer.buffer
}

export interface GpuSupport {
  available: boolean
  /** fp16 가중치 실행에 필요한 shader-f16 지원 여부 */
  f16: boolean
}

export async function detectWebGpu(): Promise<GpuSupport> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    if (!gpu) return { available: false, f16: false }
    const adapter = (await gpu.requestAdapter()) as { features: Set<string> } | null
    if (!adapter) return { available: false, f16: false }
    return { available: true, f16: adapter.features.has('shader-f16') }
  } catch {
    return { available: false, f16: false }
  }
}

/** 제한 시간 안에 끝나지 않으면 실패 처리 — 멈춘 초기화가 화면을 붙잡지 않게 한다 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 시간 초과(${ms / 1000}초)`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}
