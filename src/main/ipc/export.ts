/**
 * 내보내기 사이드카 IPC (S6 세션 2) — Electron 메인 ↔ Python NDJSON 클라이언트.
 *
 * - S6-1에서 확립한 프로토콜 그대로: `python -u server.py` 스폰, NDJSON
 *   JSON-RPC 2.0 (ping/render/shutdown), UTF-8 파이프, 매 줄 flush 상대
 *   읽기는 readline으로 즉시 처리한다.
 * - 응답 구분: "method" 키가 있으면 progress 알림(id 없음), 없으면 요청 응답
 *   (id 매칭) — server.py 계약과 대칭.
 * - 진행률은 렌더러에 `export:progress` 이벤트로 push. 취소는 자식 프로세스
 *   종료로 수행하며 다음 요청 때 사이드카가 자동 재시작된다.
 * - 스폰 대상(S7 패키징 정책): `DTF_SIDECAR_PYTHON`(확장자 .exe면 PyInstaller
 *   번들 사이드카로 간주 — 인자 없음) → 패키지 모드 `resources/dtf-sidecar/
 *   dtf-sidecar.exe` → 개발 모드 `export-sidecar/.venv` → PATH `python`.
 */
import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { createInterface } from 'node:readline'
import type { ExportManifest } from '../../workers/exportManifest'
import type {
  AutoTrimSidecarResult,
  ExportProgress,
  ExportResult,
  RemoveBgSidecarResult,
  UpscaleSidecarProgress,
  UpscaleSidecarRequest,
  UpscaleSidecarResult
} from '../../types/ipc'
import { saveDefaultPath, saveLastDir } from './dialogMemory'

const PING_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 3_000
/** 배경 제거 상한 — 기본 모델(isnet, 약 170MB)은 번들·예열되므로 여유 포함 3분 */
const REMOVE_BG_TIMEOUT_MS = 180_000
/** 자동 트림 상한 — 디코드+numpy bbox+크롭 재인코딩(4K+ 여유) */
const AUTO_TRIM_TIMEOUT_MS = 60_000
/** 예열 상한 — 번들이 없는 첫 개발 실행은 가중치 다운로드까지 흡수한다 */
const WARMUP_TIMEOUT_MS = 300_000
/** 업스케일 상한 — 체인 전체(스텝별 상한은 사이드카가 5분으로 강제, §6.2) */
const UPSCALE_TIMEOUT_MS = 20 * 60_000
/** 번들 기본 모델 파일명 — export-sidecar/removebg.py DEFAULT_MODEL과 동기 */
const DEFAULT_MODEL_FILE = 'isnet-general-use.onnx'
/** 스폰 실패 진단용 stderr 꼬리 상한 */
const STDERR_TAIL_CHARS = 2_000

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface JsonRpcError {
  code: number
  message: string
}

/** 사이드카 스폰·요청·알림 수신을 관리 — 렌더 1회마다 재사용되는 장수 클라이언트 */
class SidecarManager {
  private child: ChildProcess | null = null
  private stdin: NodeJS.WritableStream | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private stderrTail = ''
  /** 장기 작업 세마포어 — render·removeBg 상호 배타(사이드카는 단일 추론 프로세스) */
  private busy = false
  private onProgress: ((progress: ExportProgress) => void) | null = null
  private upscaleProgressHandler: ((progress: UpscaleSidecarProgress) => void) | null = null

  /** 렌더 진행 — render 호출부가 설정, 렌더 종료 시 해제 */
  set onProgressHandler(handler: ((progress: ExportProgress) => void) | null) {
    this.onProgress = handler
  }

  /** 스폰 대상 해석 — 패키지 모드는 번들 exe, 개발 모드는 인터프리터+server.py */
  private resolveCommand(): { command: string; args: string[] } {
    const override = process.env.DTF_SIDECAR_PYTHON
    if (override) {
      // .exe = PyInstaller onefile 번들(진입점 내장) — `-u server.py` 인자 불필요
      return extname(override).toLowerCase() === '.exe'
        ? { command: override, args: [] }
        : { command: override, args: ['-u', this.resolveServerPath()] }
    }
    if (app.isPackaged) {
      return {
        command: join(process.resourcesPath, 'dtf-sidecar', 'dtf-sidecar.exe'),
        args: []
      }
    }
    const appPath = app.getAppPath()
    const candidates =
      process.platform === 'win32'
        ? [join(appPath, 'export-sidecar', '.venv', 'Scripts', 'python.exe')]
        : [join(appPath, 'export-sidecar', '.venv', 'bin', 'python')]
    const found = candidates.find((p) => existsSync(p))
    return { command: found ?? 'python', args: ['-u', this.resolveServerPath()] }
  }

  private resolveServerPath(): string {
    return join(app.getAppPath(), 'export-sidecar', 'server.py')
  }

  /** rembg 가중치 홈(U2NET_HOME) — 번들 모델(읽기 전용)을 우선, 없으면 userData.
   *  rembg 2.0.81은 <home>/<model>.onnx 플랫 레이아웃(legacy)도 조회하므로
   *  resources/models에 파일을 평평하게 번들해도 즉시 발견된다(sessions/base.py). */
  private resolveModelsHome(): string {
    const candidates = app.isPackaged
      ? [join(process.resourcesPath, 'models')]
      : [join(app.getAppPath(), 'resources', 'models')]
    const bundled = candidates.find((dir) => existsSync(join(dir, DEFAULT_MODEL_FILE)))
    return bundled ?? join(app.getPath('userData'), 'models')
  }

  private spawnProcess(): void {
    const { command, args } = this.resolveCommand()
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // U2NET_HOME — rembg 모델 가중치 홈(REMOVEBG.MD §2). 번들 기본 모델이 있으면
      // 그 읽기 전용 폴더, 없으면 userData(첫 사용 시 다운로드 후 오프라인 재사용)
      // PYTHONUTF8=1 — Python UTF-8 모드: 서드파티가 시스템 로캘(cp1252 등 charmap
      // 계열)로 텍스트 인코딩하는 경로까지 전부 UTF-8로 강제. 서양권 로캘 기기에서
      // 한글 경로·레이어명 렌더 시 UnicodeEncodeError(-32603)가 나던 결함 대응
      // (2026-09-02 접수 — stdio는 server.py가 이미 재구성하지만 라이브러리 내부
      // 로캘 인코딩까지 포괄 방어)
      env: {
        ...process.env,
        U2NET_HOME: this.resolveModelsHome(),
        PYTHONUTF8: '1'
      }
    })
    this.child = child
    this.stdin = child.stdin

    child.stdout?.setEncoding('utf-8')
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => this.handleLine(line))

    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
    })

    child.on('error', (err) => this.failAllPending(new Error(`사이드카 실행 실패: ${err.message}`)))
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null
        this.stdin = null
        this.failAllPending(new Error('사이드카가 예기치 않게 종료되었습니다'))
      }
    })
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let message: object
    try {
      message = JSON.parse(trimmed) as object
    } catch {
      console.error(`[sidecar] 프로토콜 위반 라인 무시: ${trimmed.slice(0, 200)}`)
      return
    }
    if ('method' in message && typeof (message as { method: unknown }).method === 'string') {
      this.dispatchNotification(message as { method: string; params?: unknown })
      return
    }
    this.dispatchResponse(message as { id?: unknown; result?: unknown; error?: JsonRpcError })
  }

  private dispatchNotification(message: { method: string; params?: unknown }): void {
    if (message.method !== 'progress') return
    const params = message.params as Record<string, unknown> | undefined
    if (!params || typeof params.stage !== 'string') return
    const { stage } = params
    const isCounted = typeof params.current === 'number' && typeof params.total === 'number'
    if (isCounted && (stage === 'items' || stage === 'write')) {
      this.onProgress?.({
        stage,
        current: params.current,
        total: params.total
      } as ExportProgress)
      return
    }
    if (
      isCounted &&
      (stage === 'step' || stage === 'tile' || stage === 'encode') &&
      typeof params.step === 'number' &&
      typeof params.total_steps === 'number'
    ) {
      this.upscaleProgressHandler?.({
        stage,
        step: params.step,
        total_steps: params.total_steps,
        current: params.current,
        total: params.total
      } as UpscaleSidecarProgress)
    }
  }

  private dispatchResponse(message: {
    id?: unknown
    result?: unknown
    error?: JsonRpcError
  }): void {
    const id = typeof message.id === 'number' ? message.id : null
    if (id === null) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (message.error) {
      pending.reject(new Error(`사이드카 오류(${message.error.code}): ${message.error.message}`))
    } else {
      pending.resolve(message.result)
    }
  }

  private failAllPending(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(error)
  }

  private writeRequest(method: string, params?: unknown): number {
    if (!this.stdin) throw new Error('사이드카가 실행 중이 아닙니다')
    const id = this.nextId++
    const request: Record<string, unknown> = { jsonrpc: '2.0', id, method }
    if (params !== undefined) request.params = params
    this.stdin.write(`${JSON.stringify(request)}\n`)
    return id
  }

  private request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.writeRequest(method, params)
    return new Promise((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject }
      this.pending.set(id, entry)
      if (timeoutMs !== undefined) {
        const timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            entry.reject(
              new Error(
                `메모리가 부족합니다. 사이드카 ${method} 응답 대기 시간 초과(${timeoutMs}ms) — ${this.stderrTail}`
              )
            )
          }
        }, timeoutMs)
        entry.resolve = (value) => {
          clearTimeout(timer)
          resolve(value)
        }
        entry.reject = (error) => {
          clearTimeout(timer)
          reject(error)
        }
      }
    })
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed && this.stdin) return
    this.spawnProcess()
    await this.request('ping', undefined, PING_TIMEOUT_MS)
  }

  /** 매니페스트 렌더 — 진행 알림은 handler로, 결과는 메타데이터만 반환 */
  async render(
    manifest: ExportManifest,
    onProgress: (progress: ExportProgress) => void
  ): Promise<ExportResult> {
    if (this.busy) throw new Error('이미 내보내기가 진행 중입니다')
    this.busy = true
    this.onProgress = onProgress
    try {
      await this.ensureStarted()
      const result = (await this.request('render', manifest)) as Partial<ExportResult>
      if (
        typeof result.output_path !== 'string' ||
        typeof result.width_px !== 'number' ||
        typeof result.height_px !== 'number' ||
        typeof result.layer_count !== 'number' ||
        typeof result.duration_ms !== 'number'
      ) {
        throw new Error(`사이드카 응답 스키마 위반: ${JSON.stringify(result).slice(0, 300)}`)
      }
      return result as ExportResult
    } finally {
      this.busy = false
      this.onProgress = null
    }
  }

  /** 배경 제거(v2) — 첫 요청은 모델 로딩·다운로드(수 분)를 포함할 수 있다 */
  async removeBg(inputPath: string, outputPath: string): Promise<RemoveBgSidecarResult> {
    if (this.busy) throw new Error('사이드카 작업(내보내기·배경 제거)이 이미 진행 중입니다')
    this.busy = true
    try {
      await this.ensureStarted()
      const result = (await this.request(
        'remove_bg',
        { input_path: inputPath, output_path: outputPath },
        REMOVE_BG_TIMEOUT_MS
      )) as Partial<RemoveBgSidecarResult>
      if (
        typeof result.output_path !== 'string' ||
        typeof result.width_px !== 'number' ||
        typeof result.height_px !== 'number'
      ) {
        throw new Error(`사이드카 응답 스키마 위반: ${JSON.stringify(result).slice(0, 300)}`)
      }
      return result as RemoveBgSidecarResult
    } finally {
      this.busy = false
    }
  }

  /** 투명 여백 자동 트림 — no-op(trimmed=false)이면 output_path는 입력 경로 그대로 */
  async autoTrim(
    inputPath: string,
    outputPath: string,
    alphaThreshold: number
  ): Promise<AutoTrimSidecarResult> {
    if (this.busy) throw new Error('사이드카 작업(내보내기·배경 제거)이 이미 진행 중입니다')
    this.busy = true
    try {
      await this.ensureStarted()
      const result = (await this.request(
        'auto_trim',
        {
          input_path: inputPath,
          output_path: outputPath,
          alpha_threshold: alphaThreshold
        },
        AUTO_TRIM_TIMEOUT_MS
      )) as Partial<AutoTrimSidecarResult>
      if (
        typeof result.output_path !== 'string' ||
        typeof result.width_px !== 'number' ||
        typeof result.height_px !== 'number' ||
        typeof result.trimmed !== 'boolean'
      ) {
        throw new Error(`사이드카 응답 스키마 위반: ${JSON.stringify(result).slice(0, 300)}`)
      }
      return result as AutoTrimSidecarResult
    } finally {
      this.busy = false
    }
  }

  /** 단계별 AI 업스케일 — 체인을 통째로 위임하고 step/tile/encode 진행을 발신.
   *  스텝별 상한(5분)은 사이드카가 강제한다(§6.2). */
  async upscale(
    params: UpscaleSidecarRequest,
    onProgress: (progress: UpscaleSidecarProgress) => void
  ): Promise<UpscaleSidecarResult> {
    if (this.busy) throw new Error('사이드카 작업(내보내기·배경 제거)이 이미 진행 중입니다')
    this.busy = true
    this.upscaleProgressHandler = onProgress
    try {
      await this.ensureStarted()
      const result = (await this.request(
        'upscale',
        params,
        UPSCALE_TIMEOUT_MS
      )) as Partial<UpscaleSidecarResult>
      if (
        typeof result.output_path !== 'string' ||
        typeof result.width_px !== 'number' ||
        typeof result.height_px !== 'number' ||
        typeof result.duration_ms !== 'number' ||
        !Array.isArray(result.steps)
      ) {
        throw new Error(`사이드카 응답 스키마 위반: ${JSON.stringify(result).slice(0, 300)}`)
      }
      return result as UpscaleSidecarResult
    } finally {
      this.busy = false
      this.upscaleProgressHandler = null
    }
  }

  /** 사이드카 예열 — 기본 모델 세션을 미리 로딩해 첫 remove_bg 대기를 흡수.
   *  busy를 잡지 않는다: 요청은 서버에서 순차 처리되므로 예열 도중 사용자가
   *  배경 제거를 누르면 두 요청이 파이프라인으로 이어지고 로딩 결과를 공유한다.
   *  실패는 무시(로그만) — 이후 요청이 요청 시 로딩으로 폴백한다. */
  async warmup(): Promise<void> {
    try {
      await this.ensureStarted()
      await this.request('warmup', undefined, WARMUP_TIMEOUT_MS)
    } catch (err) {
      console.error(
        `[sidecar] 예열 실패(무시됨 — 요청 시 재시도): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /** 진행 중 렌더 취소 — 프로세스 종료로 pending 요청이 거부된다 */
  cancel(reason: string = '내보내기가 취소되었습니다'): void {
    const child = this.child
    this.child = null
    this.stdin = null
    this.upscaleProgressHandler = null
    if (child && !child.killed) child.kill()
    this.failAllPending(new Error(reason))
  }

  /** 앱 종료 정리 — shutdown 요청 후 여유 시간 두고 kill */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    try {
      await this.request('shutdown', undefined, SHUTDOWN_TIMEOUT_MS)
    } catch {
      // 응답 없거나 이미 종료 — 아래 kill으로 마무리
    }
    if (!child.killed) child.kill()
  }
}

function saveDialogFilters(format: 'psd' | 'png' | 'pdf'): Electron.FileFilter[] {
  if (format === 'psd') return [{ name: 'Photoshop 문서 (CMYK·350DPI)', extensions: ['psd'] }]
  if (format === 'pdf') return [{ name: 'PDF 문서 (인쇄 검수용)', extensions: ['pdf'] }]
  return [{ name: 'PNG 이미지 (알파 보존)', extensions: ['png'] }]
}

const sidecar = new SidecarManager()

/** 배경 제거 요청 진입점 — removeBg.ts IPC가 사용 (사이드카 수명은 이 모듈이 소유) */
export function removeBackgroundViaSidecar(
  inputPath: string,
  outputPath: string
): Promise<RemoveBgSidecarResult> {
  return sidecar.removeBg(inputPath, outputPath)
}

/** 자동 트림 요청 진입점 — autoTrim.ts IPC가 사용 (사이드카 수명은 이 모듈이 소유) */
export function autoTrimViaSidecar(
  inputPath: string,
  outputPath: string,
  alphaThreshold: number
): Promise<AutoTrimSidecarResult> {
  return sidecar.autoTrim(inputPath, outputPath, alphaThreshold)
}

/** 업스케일 요청 진입점 — upscale.ts IPC가 사용 (사이드카 수명은 이 모듈이 소유) */
export function upscaleViaSidecar(
  params: UpscaleSidecarRequest,
  onProgress: (progress: UpscaleSidecarProgress) => void
): Promise<UpscaleSidecarResult> {
  return sidecar.upscale(params, onProgress)
}

/** 진행 중 사이드카 작업 취소 — upscale:cancel IPC가 사용 */
export function cancelSidecar(reason: string): void {
  sidecar.cancel(reason)
}

/** 배경 제거 예열 — index.ts가 앱 구동 직후 호출(비동기, 실패 무시) */
export function warmupRemoveBgSidecar(): Promise<void> {
  return sidecar.warmup()
}

export function registerExportIpc(): void {
  ipcMain.handle('export:save-dialog', async (event, format: unknown): Promise<string | null> => {
    if (format !== 'psd' && format !== 'png' && format !== 'pdf') {
      throw new Error('내보내기 포맷은 "psd", "png" 또는 "pdf"여야 합니다')
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.SaveDialogOptions = {
      title: `${format.toUpperCase()} 내보내기`,
      defaultPath: saveDefaultPath('export', `gangsheet.${format}`),
      filters: saveDialogFilters(format)
    }
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    saveLastDir('export', result.filePath)
    return result.filePath
  })

  ipcMain.handle('export:render', async (event, manifest: unknown): Promise<ExportResult> => {
    if (typeof manifest !== 'object' || manifest === null) {
      throw new Error('내보내기 매니페스트가 올바르지 않습니다')
    }
    return sidecar.render(manifest as ExportManifest, (progress) => {
      event.sender.send('export:progress', progress)
    })
  })

  ipcMain.handle('export:cancel', () => {
    sidecar.cancel()
  })

  app.on('will-quit', () => {
    sidecar.cancel()
  })
}

/**
 * E2E 자동검증 훅 (DTF_SMOKE_TEST 패턴 계승) — DTF_EXPORT_TEST=<매니페스트 경로>로
 * 실행하면 IPC와 동일한 SidecarManager 경로로 렌더하고 결과 JSON을
 * `<매니페스트 경로>.result.json`에 남긴 뒤 앱을 종료한다.
 */
export async function runExportTestHook(): Promise<void> {
  const manifestPath = process.env.DTF_EXPORT_TEST
  if (!manifestPath) return
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ExportManifest
  const reportPath = `${manifestPath}.result.json`
  const started = Date.now()
  try {
    const result = await sidecar.render(manifest, (progress) => {
      console.log(`[export-test] ${JSON.stringify(progress)}`)
    })
    writeFileSync(
      reportPath,
      JSON.stringify({ ok: true, result, elapsed_ms: Date.now() - started }, null, 2),
      'utf-8'
    )
    console.log(`[export-test] OK -> ${reportPath}`)
  } catch (err) {
    writeFileSync(
      reportPath,
      JSON.stringify(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        null,
        2
      ),
      'utf-8'
    )
    console.error(`[export-test] FAILED: ${String(err)}`)
  } finally {
    await sidecar.stop()
    app.quit()
  }
}
