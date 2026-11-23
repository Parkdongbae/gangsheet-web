/**
 * AI 업스케일 워커 — Real-ESRGAN 소형 모델(x4)을 onnxruntime-web으로 타일 실행한다.
 *
 * - 엔진: general = realesr-general-x4v3(사진·그래픽), anime = AnimeVideo-v3(라인아트)
 * - 실행 장치: WebGPU 우선, 실패 시 WASM 폴백
 * - 알파: 모델은 RGB만 다루므로 투명 영역 RGB를 주변색으로 채운 뒤 확대하고,
 *   알파 채널은 고품질 보간으로 따로 키워 합친다(투명 경계의 어두운 테두리 방지)
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
  MODEL_SCALE,
  bleedTransparentRgb,
  fillTileInput,
  planTiles,
  writeTileOutput
} from './tiles'

export type UpEngine = 'general' | 'anime'

interface EngineModel {
  /** 모델 입력 한 변(px) — 고정 크기 모델은 그 값, 가변 모델은 속도·메모리 균형값 */
  tileInput: number
  /** WebGPU에서 실행할 수 없는 모델 — 처음부터 WASM으로 실행 */
  cpuOnly?: boolean
  model: ModelSource
  /** 가중치가 별도 파일(external data)로 분리된 모델 */
  data?: ModelSource & { path: string }
}

/** 리비전 고정 — Real-ESRGAN 가중치(BSD-3-Clause)의 ONNX 변환본 */
const MODELS: Record<UpEngine, EngineModel> = {
  general: {
    tileInput: 128,
    model: {
      url: 'https://huggingface.co/TheGuy444/Real-ESRGAN-ONNX/resolve/4c80f3da1a8a85f0757a9e7f79e08d0307220eb5/onnx/model.onnx',
      bytes: 40_000
    },
    data: {
      path: 'model.data',
      url: 'https://huggingface.co/TheGuy444/Real-ESRGAN-ONNX/resolve/4c80f3da1a8a85f0757a9e7f79e08d0307220eb5/onnx/model.data',
      bytes: 4_870_000
    }
  },
  anime: {
    tileInput: 256,
    // 이 변환본은 입력·출력이 같은 기호 차원명을 써서 WebGPU 실행기가 출력 크기를
    // 혼동한다(Shape mismatch, onnxruntime-web 1.31.1 실측). 2.4MB 소형이라 CPU로도 충분
    cpuOnly: true,
    model: {
      url: 'https://huggingface.co/tidus2102/Real-ESRGAN/resolve/c9a1cd990b587ccf20be2373fad8eb021e24ab01/RealESR-AnimeVideo-v3_x4.onnx',
      bytes: 2_500_000
    }
  }
}

const GPU_INIT_TIMEOUT_MS = 60_000
const GPU_TILE_TIMEOUT_MS = 60_000

export type UpWorkerRequest = {
  type: 'run'
  id: number
  bitmap: ImageBitmap
  engine: UpEngine
  /** x4 통과 횟수(1~3) */
  passes: number
  forceWasm?: boolean
}
export type UpWorkerResponse =
  | { type: 'progress'; id: number; stage: 'download' | 'init'; ratio?: number }
  | { type: 'progress'; id: number; stage: 'tile' | 'encode'; current: number; total: number }
  | { type: 'done'; id: number; bitmap: ImageBitmap; backend: string; ms: number }
  | { type: 'error'; id: number; message: string }

interface Engine {
  session: ort.InferenceSession
  backend: 'webgpu' | 'wasm'
  tileInput: number
}

const post = (message: UpWorkerResponse, transfer: Transferable[] = []): void => {
  ;(self as unknown as Worker).postMessage(message, transfer)
}

const engines = new Map<string, Promise<Engine>>()
/** WebGPU가 실패해 WASM으로 고정된 엔진 */
const wasmOnly = new Set<UpEngine>()
let forceWasm = false

async function createEngine(id: number, engine: UpEngine, useWasm: boolean): Promise<Engine> {
  configureOrt()
  const spec = MODELS[engine]
  const totalBytes = spec.model.bytes + (spec.data?.bytes ?? 0)
  let modelLoaded = 0
  const report = (loaded: number): void =>
    post({ type: 'progress', id, stage: 'download', ratio: Math.min(0.999, loaded / totalBytes) })
  const model = await fetchModel(spec.model, (ratio) => {
    modelLoaded = ratio * spec.model.bytes
    report(modelLoaded)
  })
  const external = spec.data
    ? [
        {
          path: spec.data.path,
          data: new Uint8Array(
            await fetchModel(spec.data, (ratio) =>
              report(spec.model.bytes + ratio * (spec.data?.bytes ?? 0))
            )
          )
        }
      ]
    : undefined
  post({ type: 'progress', id, stage: 'init' })

  const create = (provider: 'webgpu' | 'wasm'): Promise<ort.InferenceSession> =>
    ort.InferenceSession.create(model.slice(0), {
      executionProviders: [provider],
      graphOptimizationLevel: 'all',
      ...(external ? { externalData: external } : {})
    })

  if (!useWasm && (await detectWebGpu()).available) {
    try {
      const session = await withTimeout(create('webgpu'), GPU_INIT_TIMEOUT_MS, 'WebGPU 준비')
      return { session, backend: 'webgpu', tileInput: spec.tileInput }
    } catch (err) {
      console.warn('[up] WebGPU 초기화 실패 — WASM으로 전환', err)
    }
  }
  return { session: await create('wasm'), backend: 'wasm', tileInput: spec.tileInput }
}

function getEngine(id: number, engine: UpEngine): Promise<Engine> {
  const useWasm = forceWasm || wasmOnly.has(engine) || MODELS[engine].cpuOnly === true
  const key = `${engine}:${useWasm ? 'wasm' : 'auto'}`
  let promise = engines.get(key)
  if (!promise) {
    promise = createEngine(id, engine, useWasm).catch((err: unknown) => {
      engines.delete(key)
      throw err
    })
    engines.set(key, promise)
  }
  return promise
}

async function runTile(engine: Engine, input: Float32Array): Promise<ArrayLike<number>> {
  const side = engine.tileInput
  const tensor = new ort.Tensor('float32', input, [1, 3, side, side])
  const inputName = engine.session.inputNames[0]!
  const outputName = engine.session.outputNames[0]!
  const results = await engine.session.run({ [inputName]: tensor }, [outputName])
  const output = results[outputName]!
  const data = (await output.getData()) as ArrayLike<number>
  const expected = 3 * side * MODEL_SCALE * side * MODEL_SCALE
  if (data.length !== expected) {
    throw new Error(`예상과 다른 모델 출력 크기: ${data.length} (기대 ${expected})`)
  }
  if (!Number.isFinite(data[0]!) || !Number.isFinite(data[data.length >> 1]!)) {
    throw new Error('모델 출력에 유효하지 않은 값이 있습니다')
  }
  const copy = Float32Array.from(data)
  output.dispose?.()
  return copy
}

/** RGBA 한 장을 x4로 확대 — onTile(완료 타일 수) */
async function upscaleOnce(
  id: number,
  engineKind: UpEngine,
  source: ImageData,
  onTile: () => void
): Promise<{ image: ImageData; backend: string }> {
  const { width, height } = source
  const rgba = new Uint8ClampedArray(source.data)
  const hasAlpha = bleedTransparentRgb(rgba, width, height)

  const outW = width * MODEL_SCALE
  const outH = height * MODEL_SCALE
  const out = new ImageData(outW, outH)
  let engine = await getEngine(id, engineKind)
  const side = engine.tileInput
  const input = new Float32Array(3 * side * side)

  for (const tile of planTiles(width, height, side)) {
    fillTileInput(input, rgba, width, height, tile, side)
    let output: ArrayLike<number>
    try {
      output =
        engine.backend === 'webgpu'
          ? await withTimeout(runTile(engine, input), GPU_TILE_TIMEOUT_MS, 'WebGPU 추론')
          : await runTile(engine, input)
    } catch (err) {
      if (engine.backend !== 'webgpu') throw err
      console.warn('[up] WebGPU 추론 실패 — WASM으로 재시도', err)
      wasmOnly.add(engineKind)
      engine = await getEngine(id, engineKind)
      output = await runTile(engine, input)
    }
    writeTileOutput(out.data, outW, output, tile, side)
    onTile()
  }

  if (hasAlpha) {
    // 알파만 고품질 보간으로 확대해 덮어쓴다
    const srcCanvas = new OffscreenCanvas(width, height)
    srcCanvas.getContext('2d')?.putImageData(source, 0, 0)
    const alphaCanvas = new OffscreenCanvas(outW, outH)
    const ctx = alphaCanvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('2D 컨텍스트를 생성할 수 없습니다')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(srcCanvas, 0, 0, outW, outH)
    const alpha = ctx.getImageData(0, 0, outW, outH).data
    const dest = out.data
    for (let i = 3; i < dest.length; i += 4) dest[i] = alpha[i]!
  }
  return { image: out, backend: engine.backend }
}

async function run(request: UpWorkerRequest): Promise<void> {
  const { id, bitmap, engine, passes } = request
  const started = performance.now()
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D 컨텍스트를 생성할 수 없습니다')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  let image = ctx.getImageData(0, 0, canvas.width, canvas.height)

  // 전체 타일 수(통과마다 16배) — 진행률 분모
  let totalTiles = 0
  for (let pass = 0, w = image.width, h = image.height; pass < passes; pass++) {
    totalTiles += planTiles(w, h, MODELS[engine].tileInput).length
    w *= MODEL_SCALE
    h *= MODEL_SCALE
  }
  let doneTiles = 0
  let backend = 'wasm'
  for (let pass = 0; pass < passes; pass++) {
    const result = await upscaleOnce(id, engine, image, () => {
      doneTiles++
      post({ type: 'progress', id, stage: 'tile', current: doneTiles, total: totalTiles })
    })
    image = result.image
    backend = result.backend
  }

  post({ type: 'progress', id, stage: 'encode', current: totalTiles, total: totalTiles })
  const result = await createImageBitmap(image)
  post({ type: 'done', id, bitmap: result, backend, ms: Math.round(performance.now() - started) }, [
    result
  ])
}

self.onmessage = (event: MessageEvent<UpWorkerRequest>): void => {
  const request = event.data
  if (request.forceWasm) forceWasm = true
  run(request).catch((err: unknown) => {
    post({
      type: 'error',
      id: request.id,
      message: err instanceof Error ? err.message : String(err)
    })
  })
}
