/**
 * AI 배경 제거 워커 — ISNet general-use(DIS) ONNX를 onnxruntime-web으로 실행한다.
 *
 * - 실행 장치: WebGPU 우선(fp16 가중치), 불가·실패 시 WASM(fp32 가중치)으로 폴백
 * - 가중치: 첫 사용 시 Hugging Face에서 내려받아 Cache Storage에 보관(재방문 즉시 로드)
 * - 이미지 픽셀은 이 워커 밖으로 나가지 않는다(네트워크 요청은 가중치 다운로드뿐)
 */
import {
  configureOrt,
  detectWebGpu,
  fetchModel,
  ort,
  withTimeout,
  type ModelSource
} from '../ai/ortRuntime'
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
const MODELS: Record<'fp16' | 'fp32', ModelSource> = {
  fp16: { url: `${MODEL_REPO}/model_fp16.onnx`, bytes: 88_200_000 },
  fp32: { url: `${MODEL_REPO}/model.onnx`, bytes: 176_100_000 }
}
/** 이 시간 안에 준비·추론이 끝나지 않으면 멈춘 것으로 보고 다음 수단으로 넘어간다 */
const GPU_INIT_TIMEOUT_MS = 60_000
const GPU_INFER_TIMEOUT_MS = 60_000
const WASM_INIT_TIMEOUT_MS = 180_000

export type BgBackend = 'webgpu' | 'wasm'
export type BgWorkerRequest = {
  type: 'run'
  id: number
  bitmap: ImageBitmap
  /** WebGPU를 건너뛰고 WASM으로 실행(문제 해결용) */
  forceWasm?: boolean
}
export type BgStage = 'download' | 'init' | 'infer' | 'refine' | 'encode'
export type BgWorkerResponse =
  | { type: 'progress'; id: number; stage: BgStage; ratio?: number; backend?: BgBackend }
  | {
      type: 'done'
      id: number
      blob: Blob
      backend: BgBackend
      ms: number
      /** 단계별 실제 소요(ms) — 다음 실행의 남은 시간 예측에 쓴다 */
      timings: Partial<Record<BgStage, number>>
    }
  | { type: 'error'; id: number; message: string }

interface Engine {
  session: ort.InferenceSession
  backend: BgBackend
  half: boolean
}

const post = (message: BgWorkerResponse): void => {
  ;(self as unknown as Worker).postMessage(message)
}

let enginePromise: Promise<Engine> | null = null
let forceWasm = false

async function createEngine(id: number): Promise<Engine> {
  configureOrt()
  const onRatio =
    (backend: BgBackend) =>
    (ratio: number): void =>
      post({ type: 'progress', id, stage: 'download', ratio, backend })

  if (!forceWasm && (await detectWebGpu()).f16) {
    try {
      const weights = await fetchModel(MODELS.fp16, onRatio('webgpu'))
      post({ type: 'progress', id, stage: 'init', backend: 'webgpu' })
      const session = await withTimeout(
        ort.InferenceSession.create(weights, {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all'
        }),
        GPU_INIT_TIMEOUT_MS,
        'WebGPU 준비'
      )
      const inputType = session.inputMetadata?.[0]
      const half = inputType?.isTensor === true && inputType.type === 'float16'
      return { session, backend: 'webgpu', half }
    } catch (err) {
      console.warn('[bg] WebGPU 초기화 실패 — WASM으로 전환', err)
    }
  }

  const weights = await fetchModel(MODELS.fp32, onRatio('wasm'))
  post({ type: 'progress', id, stage: 'init', backend: 'wasm' })
  const session = await withTimeout(
    ort.InferenceSession.create(weights, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    }),
    WASM_INIT_TIMEOUT_MS,
    'AI 엔진 준비'
  )
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

  const marks: Partial<Record<BgStage, number>> = {}
  const timings: Partial<Record<BgStage, number>> = {}
  let current: BgStage | null = null
  const enter = (stage: BgStage | null): void => {
    const now = performance.now()
    if (current) timings[current] = Math.round(now - (marks[current] ?? now))
    current = stage
    if (stage) marks[stage] = now
  }

  let engine = await getEngine(id)
  enter('infer')
  post({ type: 'progress', id, stage: 'infer', backend: engine.backend })
  let mask: Float32Array
  try {
    mask =
      engine.backend === 'webgpu'
        ? await withTimeout(inferMask(engine, small), GPU_INFER_TIMEOUT_MS, 'WebGPU 추론')
        : await inferMask(engine, small)
  } catch (err) {
    if (engine.backend !== 'webgpu') throw err
    // GPU 드라이버 문제(fp16 미지원 연산·장치 손실 등) — WASM으로 한 번 더 시도
    console.warn('[bg] WebGPU 추론 실패 — WASM으로 재시도', err)
    forceWasm = true
    enginePromise = null
    engine = await getEngine(id)
    enter('infer')
    post({ type: 'progress', id, stage: 'infer', backend: engine.backend })
    mask = await inferMask(engine, small)
  }

  enter('refine')
  post({ type: 'progress', id, stage: 'refine', backend: engine.backend })
  const image = fullCtx.getImageData(0, 0, width, height)
  const opaque = composeAlpha(image.data, width, height, small, mask, MODEL_SIZE)
  if (opaque === 0) {
    throw new Error('피사체를 찾지 못했습니다. "단색 배경" 방식을 사용해 보세요.')
  }
  fullCtx.putImageData(image, 0, 0)

  enter('encode')
  post({ type: 'progress', id, stage: 'encode', backend: engine.backend })
  const blob = await fullCanvas.convertToBlob({ type: 'image/png' })
  enter(null)
  post({
    type: 'done',
    id,
    blob,
    backend: engine.backend,
    ms: Math.round(performance.now() - started),
    timings
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
