/**
 * AI 배경 제거 워커 — ISNet general-use(DIS) ONNX를 onnxruntime-web으로 실행한다.
 *
 * - 실행 장치: WebGPU 우선(fp16 가중치), 불가·실패 시 WASM(fp32 가중치)으로 폴백
 * - 가중치: 첫 사용 시 Hugging Face에서 내려받아 Cache Storage에 보관(재방문 즉시 로드)
 * - 이미지 픽셀은 이 워커 밖으로 나가지 않는다(네트워크 요청은 가중치 다운로드뿐)
 */
import * as ort from 'onnxruntime-web/webgpu'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import {
  MODEL_SIZE,
  composeAlpha,
  fromFloat16,
  normalizeMask,
  toFloat16,
  toInputTensor
} from './matting'

/** imgly/isnet-general-onnx (MIT) — 리비전 고정으로 가중치 변조·교체를 차단 */
const MODEL_REPO =
  'https://huggingface.co/imgly/isnet-general-onnx/resolve/440dea96dd4a3b06bbbf5abec3e26569dd7ec49f/onnx'
const MODELS = {
  fp16: { url: `${MODEL_REPO}/model_fp16.onnx`, bytes: 88_200_000 },
  fp32: { url: `${MODEL_REPO}/model.onnx`, bytes: 176_100_000 }
} as const
const CACHE_NAME = 'dtf-bg-models-v1'

export type BgWorkerRequest = {
  type: 'run'
  id: number
  bitmap: ImageBitmap
  /** WebGPU를 건너뛰고 WASM으로 실행(문제 해결용) */
  forceWasm?: boolean
}
export type BgStage = 'download' | 'init' | 'infer' | 'refine' | 'encode'
export type BgWorkerResponse =
  | { type: 'progress'; id: number; stage: BgStage; ratio?: number }
  | { type: 'done'; id: number; blob: Blob; backend: string; ms: number }
  | { type: 'error'; id: number; message: string }

interface Engine {
  session: ort.InferenceSession
  backend: 'webgpu' | 'wasm'
  half: boolean
}

const post = (message: BgWorkerResponse): void => {
  ;(self as unknown as Worker).postMessage(message)
}

async function fetchModel(
  model: (typeof MODELS)[keyof typeof MODELS],
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
  if (!res.ok || !res.body) throw new Error(`모델 다운로드 실패 (HTTP ${res.status})`)
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

async function hasWebGpuF16(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    if (!gpu) return false
    const adapter = (await gpu.requestAdapter()) as { features: Set<string> } | null
    return adapter !== null && adapter.features.has('shader-f16')
  } catch {
    return false
  }
}

let enginePromise: Promise<Engine> | null = null
let forceWasm = false

async function createEngine(id: number): Promise<Engine> {
  ort.env.wasm.wasmPaths = { wasm: wasmUrl }
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
    : 1
  const onRatio = (ratio: number): void => post({ type: 'progress', id, stage: 'download', ratio })

  if (!forceWasm && (await hasWebGpuF16())) {
    try {
      const weights = await fetchModel(MODELS.fp16, onRatio)
      post({ type: 'progress', id, stage: 'init' })
      const session = await ort.InferenceSession.create(weights, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all'
      })
      const inputType = session.inputMetadata?.[0]
      const half = inputType?.isTensor === true && inputType.type === 'float16'
      return { session, backend: 'webgpu', half }
    } catch (err) {
      console.warn('[bg] WebGPU 초기화 실패 — WASM으로 전환', err)
    }
  }

  const weights = await fetchModel(MODELS.fp32, onRatio)
  post({ type: 'progress', id, stage: 'init' })
  const session = await ort.InferenceSession.create(weights, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  })
  return { session, backend: 'wasm', half: false }
}

function getEngine(id: number): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = createEngine(id).catch((err: unknown) => {
      enginePromise = null
      throw err
    })
  }
  return enginePromise
}

async function inferMask(engine: Engine, small: Uint8ClampedArray): Promise<Float32Array> {
  const chw = toInputTensor(small, MODEL_SIZE)
  const dims = [1, 3, MODEL_SIZE, MODEL_SIZE]
  const input = engine.half
    ? new ort.Tensor('float16', toFloat16(chw), dims)
    : new ort.Tensor('float32', chw, dims)
  const inputName = engine.session.inputNames[0]!
  const outputName = engine.session.outputNames[0]!
  const results = await engine.session.run({ [inputName]: input }, [outputName])
  const output = results[outputName]!
  const raw = (await output.getData()) as ArrayLike<number>
  const mask =
    output.type === 'float16' && raw instanceof Uint16Array
      ? fromFloat16(raw)
      : Float32Array.from(raw)
  for (const tensor of Object.values(results)) tensor.dispose?.()
  if (mask.length !== MODEL_SIZE * MODEL_SIZE) {
    throw new Error(`예상과 다른 마스크 크기: ${mask.length}`)
  }
  for (let i = 0; i < mask.length; i += 997) {
    if (!Number.isFinite(mask[i]!)) throw new Error('마스크에 유효하지 않은 값이 있습니다')
  }
  return normalizeMask(mask)
}

async function run(id: number, bitmap: ImageBitmap): Promise<void> {
  const started = performance.now()
  const { width, height } = bitmap

  const smallCanvas = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE)
  const smallCtx = smallCanvas.getContext('2d', { willReadFrequently: true })
  const fullCanvas = new OffscreenCanvas(width, height)
  const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true })
  if (!smallCtx || !fullCtx) throw new Error('2D 컨텍스트를 생성할 수 없습니다')
  smallCtx.imageSmoothingEnabled = true
  smallCtx.imageSmoothingQuality = 'high'
  smallCtx.drawImage(bitmap, 0, 0, MODEL_SIZE, MODEL_SIZE)
  fullCtx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const small = smallCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data

  let engine = await getEngine(id)
  post({ type: 'progress', id, stage: 'infer' })
  let mask: Float32Array
  try {
    mask = await inferMask(engine, small)
  } catch (err) {
    if (engine.backend !== 'webgpu') throw err
    // GPU 드라이버 문제(fp16 미지원 연산·장치 손실 등) — WASM으로 한 번 더 시도
    console.warn('[bg] WebGPU 추론 실패 — WASM으로 재시도', err)
    forceWasm = true
    enginePromise = null
    engine = await getEngine(id)
    post({ type: 'progress', id, stage: 'infer' })
    mask = await inferMask(engine, small)
  }

  post({ type: 'progress', id, stage: 'refine' })
  const image = fullCtx.getImageData(0, 0, width, height)
  const opaque = composeAlpha(image.data, width, height, small, mask, MODEL_SIZE)
  if (opaque === 0) {
    throw new Error('피사체를 찾지 못했습니다. "단색 배경" 방식을 사용해 보세요.')
  }
  fullCtx.putImageData(image, 0, 0)

  post({ type: 'progress', id, stage: 'encode' })
  const blob = await fullCanvas.convertToBlob({ type: 'image/png' })
  post({
    type: 'done',
    id,
    blob,
    backend: engine.backend,
    ms: Math.round(performance.now() - started)
  })
}

self.onmessage = (event: MessageEvent<BgWorkerRequest>): void => {
  const { id, bitmap } = event.data
  if (event.data.forceWasm && !forceWasm) {
    forceWasm = true
    enginePromise = null
  }
  run(id, bitmap).catch((err: unknown) => {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) })
  })
}
