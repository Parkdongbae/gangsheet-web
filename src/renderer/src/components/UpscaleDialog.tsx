import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link2, Link2Off, Loader2, TriangleAlert, X, ZoomIn } from 'lucide-react'
import {
  PlanInputError,
  buildUpscalePlan,
  chainSummary,
  type FitMode,
  type StepStrategy,
  type UpscalePlan,
  type UpscaleUnit,
  type WarningCode
} from '../../../core/upscaler/plan'
import { pxToCm } from '../../../core/math'
import type {
  ImageInfo,
  UpscaleCalibration,
  UpscaleOptions,
  UpscaleProgress,
  UpscaleResumeInfo,
  UpscaledImage
} from '../../../types/ipc'

type UpscaleEngine = 'general' | 'anime'

/** 출력물 프리셋 — §3.2 (cm 치수 + 권장 DPI 동시 설정) */
interface OutputPreset {
  id: string
  label: string
  widthCm: number
  heightCm: number
  dpi: number
}

const PRESETS: readonly OutputPreset[] = [
  { id: 'business-card', label: '명함', widthCm: 9, heightCm: 5, dpi: 300 },
  { id: 'postcard', label: '엽서', widthCm: 14.8, heightCm: 10, dpi: 300 },
  { id: 'a4', label: 'A4', widthCm: 21, heightCm: 29.7, dpi: 300 },
  { id: 'a3', label: 'A3', widthCm: 29.7, heightCm: 42, dpi: 300 },
  { id: 'sns-square', label: 'SNS 정사각', widthCm: 10, heightCm: 10, dpi: 72 }
] as const

const DPI_PRESETS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '웹·SNS (72)', value: 72 },
  { label: '배너·전단 (150)', value: 150 },
  { label: '인쇄 (300)', value: 300 }
] as const

const STRATEGIES: ReadonlyArray<{ value: StepStrategy; label: string; tip: string }> = [
  { value: 'AUTO', label: '자동 추천', tip: '크기에 맞는 방식을 알아서 골라요 (기본값)' },
  {
    value: 'STEP_2X',
    label: '2배씩',
    tip: '한 번에 크게 키우면 디테일이 뭉개질 수 있어서, 나눠서 키우면 더 선명해요'
  },
  { value: 'STEP_3X', label: '3배씩', tip: '2배씩보다 단계가 줄어 조금 더 빨라요' },
  { value: 'STEP_5X', label: '5배씩', tip: '단계가 크게 줄어 속도가 빨라요 (디테일은 조금 덜)' },
  { value: 'DIRECT', label: '한 번에', tip: '소폭 확대일 때 더 깔끔해요' }
] as const

const FIT_MODES: ReadonlyArray<{ value: FitMode; label: string; desc: string }> = [
  {
    value: 'KEEP_RATIO',
    label: '비율 유지 (권장)',
    desc: '원본 비율대로 맞춰요 — 인쇄 여백은 남을 수 있어요'
  },
  { value: 'COVER', label: '맞춤 자르기', desc: '목표 비율에 맞게 원본 가장자리를 잘라요' },
  { value: 'CONTAIN', label: '여백 두기', desc: '목록 크기에 맞추고 남는 부분은 투명하게 둬요' },
  {
    value: 'STRETCH',
    label: '늘리기 (왜곡)',
    desc: '비율 무시하고 늘려요 — 그림이 일그러질 수 있어요'
  }
] as const

const WARNING_TEXT: Record<WarningCode, string> = {
  WARN_TARGET_CLAMPED: '목표 크기가 너무 커서 최대 8,000px로 자동 조정했어요',
  WARN_DOWNSCALE: '원본보다 작은 크기예요 — AI 없이 고품질 축소로 처리합니다',
  WARN_DIRECT_RECOMMENDED: '조금만 키우는 경우라 한 번에 처리하는 게 더 깔끔해요',
  WARN_LOW_DPI: 'DPI가 낮아 인쇄하면 흐릿할 수 있어요',
  WARN_RATIO_MISMATCH: '가로·세로 비율이 달라요 — 아래 비율 처리 방식을 골라주세요',
  WARN_MEMORY_TILING: '큰 이미지라 타일 단위로 나눠 처리해요 (시간이 더 걸려요)',
  WARN_OVERSIZED_TILING: '초대형 확대예요 — 단계별로 나눠 진행해 시간이 걸릴 수 있어요'
}

const FORMATS: ReadonlyArray<{ value: UpscaleOptions['format']; label: string }> = [
  { value: 'png', label: 'PNG (투명 보존)' },
  { value: 'jpeg', label: 'JPEG (작은 용량)' },
  { value: 'webp', label: 'WebP (균형)' }
] as const

const clampCm = (v: number): number => Math.min(200, Math.max(0.5, v))

/** 예상 처리 시간 포맷 — 초/분초 */
function formatDuration(ms: number): string {
  if (ms < 1000) return '1초 미만'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `약 ${sec}초`
  return `약 ${Math.floor(sec / 60)}분 ${sec % 60}초`
}

/** 예상 파일 크기(MB) — 포맷별 경험식(§3.5 "약" 표기 전제의 휴리스틱).
 *  PNG는 원본 압축률을 면적비로 환산, JPEG/WebP는 품질 대비 bit-per-pixel 근사. */
function estimateFileSizeMb(
  format: UpscaleOptions['format'],
  quality: number,
  srcBytes: number,
  srcMpx: number,
  targetMpx: number
): number {
  if (targetMpx <= 0) return 0
  if (format === 'png') {
    if (srcMpx <= 0 || srcBytes <= 0) return targetMpx * 1.1
    return Math.max(0.05, (srcBytes / 1_048_576) * (targetMpx / srcMpx) * 1.2)
  }
  if (format === 'jpeg') return targetMpx * (0.35 + quality * 1.05)
  return targetMpx * (0.2 + quality * 0.6)
}

export interface UpscaleDialogProps {
  filePath: string
  onClose: () => void
  /** 완료 결과 — 열림 시점의 항목에 에셋 치환한다(호출자가 id 캡처) */
  onDone: (result: UpscaledImage) => void
}

/** cm 기반 단계별 AI 업스케일 다이얼로그 — UPSCALER.MD v2.0 §3 UI */
export function UpscaleDialog({
  filePath,
  onClose,
  onDone
}: UpscaleDialogProps): React.JSX.Element {
  const [info, setInfo] = useState<ImageInfo | null>(null)
  const [infoError, setInfoError] = useState<string | null>(null)
  const [unit, setUnit] = useState<UpscaleUnit>('cm')
  const [widthCm, setWidthCm] = useState('10')
  const [heightCm, setHeightCm] = useState('10')
  const [widthPx, setWidthPx] = useState('')
  const [heightPx, setHeightPx] = useState('')
  const [scale, setScale] = useState('2')
  const [ratioLock, setRatioLock] = useState(true)
  const [dpi, setDpi] = useState(300)
  const [customDpi, setCustomDpi] = useState(false)
  const [strategy, setStrategy] = useState<StepStrategy>('AUTO')
  const [fitMode, setFitMode] = useState<FitMode>('KEEP_RATIO')
  const [format, setFormat] = useState<UpscaleOptions['format']>('png')
  const [quality, setQuality] = useState(0.95)
  const [running, setRunning] = useState(false)
  const [runningMode, setRunningMode] = useState<'fresh' | 'resume'>('fresh')
  const [progress, setProgress] = useState<UpscaleProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [engine, setEngine] = useState<UpscaleEngine>('general')
  const [msPerMpx, setMsPerMpx] = useState<number | null>(null)
  const [resumableRun, setResumableRun] = useState<UpscaleResumeInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api
      .getUpscaleCalibration()
      .then((calibration: UpscaleCalibration) => {
        if (!cancelled) setMsPerMpx(calibration.msPerMpx)
      })
      .catch(() => undefined)
    void window.api
      .getUpscaleResumable()
      .then((info: UpscaleResumeInfo | null) => {
        if (!cancelled) setResumableRun(info)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  /** 실패·취소 후 재개 가능 여부 갱신 — 메인 레지스트리 상태를 다시 조회 */
  const refreshResumable = useCallback((): void => {
    void window.api
      .getUpscaleResumable()
      .then((info: UpscaleResumeInfo | null) => setResumableRun(info))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api
      .imageInfo(filePath)
      .then((result) => {
        if (cancelled) return
        setInfo(result)
        // 기본값 = 원본의 물리 크기(메타 DPI 없으면 300 가정) — 초보자의 기준점 제공
        const assumed = result.dpi ?? 300
        setWidthCm(clampCm(Number(pxToCm(result.width, assumed).toFixed(1))).toFixed(1))
        setHeightCm(clampCm(Number(pxToCm(result.height, assumed).toFixed(1))).toFixed(1))
        setWidthPx(String(result.width))
        setHeightPx(String(result.height))
        setScale('2')
      })
      .catch((err: unknown) => {
        if (!cancelled) setInfoError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [filePath])

  const plan: UpscalePlan | null | 'invalid' = useMemo(() => {
    if (!info) return null
    const num = (v: string): number | undefined => {
      const parsed = Number.parseFloat(v)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    }
    try {
      return buildUpscalePlan(
        {
          unit,
          widthCm: unit === 'cm' ? num(widthCm) : undefined,
          heightCm: unit === 'cm' ? num(heightCm) : undefined,
          widthPx: unit === 'px' ? num(widthPx) : undefined,
          heightPx: unit === 'px' ? num(heightPx) : undefined,
          scale: unit === 'scale' ? num(scale) : undefined,
          dpi,
          strategy,
          fitMode
        },
        { width: info.width, height: info.height }
      )
    } catch (err) {
      if (err instanceof PlanInputError) return 'invalid'
      throw err
    }
  }, [info, unit, widthCm, heightCm, widthPx, heightPx, scale, dpi, strategy, fitMode])

  useEffect(() => {
    if (!running) return
    return window.api.onUpscaleProgress((p) => setProgress(p))
  }, [running])

  const srcAspect = info ? info.width / info.height : 1

  /** 비율 고정 — 한쪽 커밋 시 다른 쪽 자동 산출 (cm 1자리 · px 정수) */
  const commitDimension = useCallback(
    (axis: 'w' | 'h', raw: string): void => {
      const parsed = Number.parseFloat(raw)
      if (!Number.isFinite(parsed) || parsed <= 0) return
      if (!ratioLock || !info) {
        if (axis === 'w') setWidthCm(raw)
        else setHeightCm(raw)
        return
      }
      if (axis === 'w') {
        setWidthCm(raw)
        setHeightCm(clampCm(Number((parsed / srcAspect).toFixed(1))).toFixed(1))
      } else {
        setHeightCm(raw)
        setWidthCm(clampCm(Number((parsed * srcAspect).toFixed(1))).toFixed(1))
      }
    },
    [ratioLock, info, srcAspect]
  )

  const commitDimensionPx = useCallback(
    (axis: 'w' | 'h', raw: string): void => {
      const parsed = Number.parseFloat(raw)
      if (!Number.isFinite(parsed) || parsed <= 0) return
      if (axis === 'w') {
        setWidthPx(raw)
        if (ratioLock) setHeightPx(String(Math.max(1, Math.round(parsed / srcAspect))))
      } else {
        setHeightPx(raw)
        if (ratioLock) setWidthPx(String(Math.max(1, Math.round(parsed * srcAspect))))
      }
    },
    [ratioLock, srcAspect]
  )

  const applyPreset = (preset: OutputPreset): void => {
    setUnit('cm')
    setWidthCm(preset.widthCm.toFixed(1))
    setHeightCm(preset.heightCm.toFixed(1))
    setDpi(preset.dpi)
    setCustomDpi(false)
  }

  const options: UpscaleOptions | null = useMemo(() => {
    if (!plan || plan === 'invalid') return null
    const num = (v: string): number | undefined => {
      const parsed = Number.parseFloat(v)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    }
    return {
      unit,
      widthCm: unit === 'cm' ? num(widthCm) : undefined,
      heightCm: unit === 'cm' ? num(heightCm) : undefined,
      widthPx: unit === 'px' ? num(widthPx) : undefined,
      heightPx: unit === 'px' ? num(heightPx) : undefined,
      scale: unit === 'scale' ? num(scale) : undefined,
      dpi,
      stepStrategy: strategy,
      fitMode,
      format,
      quality,
      embedDpiMetadata: true,
      sharpening: 0.3,
      denoiseLevel: 0,
      engine
    }
  }, [
    plan,
    unit,
    widthCm,
    heightCm,
    widthPx,
    heightPx,
    scale,
    dpi,
    strategy,
    fitMode,
    format,
    quality,
    engine
  ])

  const start = (): void => {
    if (!options || running) return
    setRunning(true)
    setRunningMode('fresh')
    setProgress(null)
    setError(null)
    setResumableRun(null)
    void (async (): Promise<void> => {
      try {
        const result = await window.api.upscaleImage(filePath, options)
        onDone(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setRunning(false)
        refreshResumable()
      }
    })()
  }

  /** 마지막 완료 단계부터 이어서 처리 (§5.3) — 진행률 번호는 전체 체인 기준 */
  const resume = (): void => {
    if (running) return
    setRunning(true)
    setRunningMode('resume')
    setProgress(null)
    setError(null)
    void (async (): Promise<void> => {
      try {
        const result = await window.api.resumeUpscale()
        onDone(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setRunning(false)
        refreshResumable()
      }
    })()
  }

  const cancel = (): void => {
    if (!running) return
    if (window.confirm('업스케일을 취소할까요?')) {
      void window.api.cancelUpscale()
    }
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, running])

  const stepMessage = useMemo(() => {
    if (progress === null) return null
    if (progress.stage === 'encode') return '결과 저장 중…'
    if (plan !== null && plan !== 'invalid') {
      const stepScale = plan.chain[progress.step - 1]
      return `${progress.step}/${progress.totalSteps}단계 · ${stepScale}배 확대 적용 중…`
    }
    return `${progress.step}/${progress.totalSteps}단계 진행 중…`
  }, [progress, plan])

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-zinc-950/70 backdrop-blur-[2px]"
      onMouseDown={() => {
        if (!running) onClose()
      }}
    >
      <form
        className="flex max-h-[88vh] w-[520px] flex-col rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-2xl"
        role="dialog"
        aria-label="이미지 업스케일"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          start()
        }}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <ZoomIn size={16} strokeWidth={1.5} className="text-zinc-400" />
            <div className="flex flex-col">
              <h2 className="text-sm font-semibold text-zinc-100">이미지 업스케일</h2>
              <span className="text-[10px] text-zinc-500">
                {info
                  ? `원본 ${info.width}×${info.height}px${info.dpi ? ` · ${info.dpi}DPI` : ''}`
                  : '원본 정보를 읽는 중…'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!running) onClose()
            }}
            aria-label="닫기"
            className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>

        {infoError ? (
          <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {infoError}
          </p>
        ) : !info ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-zinc-500">
            <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
            원본 정보를 읽고 있어요…
          </div>
        ) : running ? (
          <div className="flex flex-col gap-3 py-6" aria-live="polite">
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-indigo-500 transition-[width] duration-150"
                style={{ width: `${Math.round((progress?.overallProgress ?? 0) * 100)}%` }}
              />
            </div>
            <p className="text-center text-xs tabular-nums text-zinc-300">
              {Math.round((progress?.overallProgress ?? 0) * 100)}% ·{' '}
              {stepMessage ?? '엔진 준비 중…'}
              {progress?.stage === 'tile' ? ` (타일 ${progress.current}/${progress.total})` : ''}
            </p>
            {plan && plan !== 'invalid' && runningMode === 'fresh' && (
              <p className="text-center text-[10px] text-zinc-500">
                전체 {plan.totalScale}배 · {chainSummary(plan.chain)} · {plan.chain.length}단계
              </p>
            )}
            {plan && plan !== 'invalid' && runningMode === 'resume' && (
              <p className="text-center text-[10px] text-zinc-500">
                이전 완료 단계부터 이어서 처리하고 있어요
              </p>
            )}
            <button
              type="button"
              onClick={cancel}
              className="mx-auto mt-1 rounded-md border border-zinc-700 bg-zinc-900 px-3.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-95"
            >
              취소
            </button>
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto pr-1">
            {/* ① 크기 입력 */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                  ① 최종 크기
                </span>
                <div className="flex overflow-hidden rounded-md border border-zinc-800">
                  {(
                    [
                      { v: 'cm', l: 'cm' },
                      { v: 'px', l: 'px' },
                      { v: 'scale', l: '배율' }
                    ] as const
                  ).map((u) => (
                    <button
                      key={u.v}
                      type="button"
                      onClick={() => setUnit(u.v)}
                      className={`px-2.5 py-1 text-[11px] transition-colors ${
                        unit === u.v
                          ? 'bg-indigo-600 text-white'
                          : 'bg-zinc-950 text-zinc-400 hover:bg-zinc-800'
                      }`}
                    >
                      {u.l}
                    </button>
                  ))}
                </div>
              </div>

              {unit === 'scale' ? (
                <label className="flex items-center gap-2 text-xs text-zinc-300">
                  원본 대비
                  <input
                    type="number"
                    min="0.1"
                    max="50"
                    step="0.1"
                    value={scale}
                    onChange={(e) => setScale(e.target.value)}
                    className="w-24 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs tabular-nums text-zinc-100 outline-none focus:border-indigo-500"
                  />
                  배
                </label>
              ) : (
                <div className="flex items-end gap-1.5">
                  <label className="flex-1 text-[10px] text-zinc-500">
                    가로 ({unit === 'cm' ? 'cm' : 'px'})
                    <input
                      type="number"
                      min={unit === 'cm' ? 0.5 : 1}
                      max={unit === 'cm' ? 200 : 30000}
                      step={unit === 'cm' ? 0.1 : 1}
                      value={unit === 'cm' ? widthCm : widthPx}
                      onChange={(e) =>
                        unit === 'cm'
                          ? commitDimension('w', e.target.value)
                          : commitDimensionPx('w', e.target.value)
                      }
                      className="mt-0.5 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs tabular-nums text-zinc-100 outline-none focus:border-indigo-500"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setRatioLock((v) => !v)}
                    title={ratioLock ? '비율 고정 해제' : '비율 고정'}
                    aria-label={ratioLock ? '비율 고정 해제' : '비율 고정'}
                    className={`mb-0.5 flex h-8 w-7 items-center justify-center rounded-md border transition-colors active:scale-95 ${
                      ratioLock
                        ? 'border-indigo-500 bg-indigo-500/15 text-indigo-300'
                        : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-800'
                    }`}
                  >
                    {ratioLock ? (
                      <Link2 size={14} strokeWidth={1.5} />
                    ) : (
                      <Link2Off size={14} strokeWidth={1.5} />
                    )}
                  </button>
                  <label className="flex-1 text-[10px] text-zinc-500">
                    세로 ({unit === 'cm' ? 'cm' : 'px'})
                    <input
                      type="number"
                      min={unit === 'cm' ? 0.5 : 1}
                      max={unit === 'cm' ? 200 : 30000}
                      step={unit === 'cm' ? 0.1 : 1}
                      value={unit === 'cm' ? heightCm : heightPx}
                      onChange={(e) =>
                        unit === 'cm'
                          ? commitDimension('h', e.target.value)
                          : commitDimensionPx('h', e.target.value)
                      }
                      className="mt-0.5 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs tabular-nums text-zinc-100 outline-none focus:border-indigo-500"
                    />
                  </label>
                </div>
              )}

              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    title={`${preset.widthCm}×${preset.heightCm}cm · ${preset.dpi}DPI`}
                    className="rounded-full border border-zinc-800 bg-zinc-950 px-2.5 py-1 text-[10px] text-zinc-300 transition-colors hover:border-indigo-500/60 hover:bg-zinc-800 hover:text-indigo-300 active:scale-95"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </section>

            {/* ② 용도 (DPI) */}
            <section className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                ② 용도 (DPI — 2.54cm당 점 개수)
              </span>
              <div className="flex gap-1.5">
                {DPI_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => {
                      setDpi(preset.value)
                      setCustomDpi(false)
                    }}
                    className={`flex-1 rounded-md border py-1.5 text-[11px] transition-colors active:scale-95 ${
                      !customDpi && dpi === preset.value
                        ? 'border-indigo-500 bg-indigo-500/15 text-indigo-300'
                        : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-800'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setCustomDpi(true)}
                  className={`flex-1 rounded-md border py-1.5 text-[11px] transition-colors active:scale-95 ${
                    customDpi
                      ? 'border-indigo-500 bg-indigo-500/15 text-indigo-300'
                      : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-800'
                  }`}
                >
                  직접 입력
                </button>
              </div>
              {customDpi && (
                <input
                  type="number"
                  min={36}
                  max={1200}
                  value={dpi}
                  onChange={(e) => setDpi(Math.round(Number(e.target.value)) || 300)}
                  className="w-28 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs tabular-nums text-zinc-100 outline-none focus:border-indigo-500"
                  aria-label="DPI 직접 입력"
                />
              )}
            </section>

            {/* ③ 처리 방식 */}
            <section className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                ③ 처리 방식
              </span>
              <div className="grid grid-cols-3 gap-1.5">
                {STRATEGIES.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    title={item.tip}
                    onClick={() => setStrategy(item.value)}
                    className={`rounded-md border py-1.5 text-[11px] transition-colors active:scale-95 ${
                      strategy === item.value
                        ? 'border-indigo-500 bg-indigo-500/15 text-indigo-300'
                        : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-800'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {window.api.aiUpscale === false ? (
                <p className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[10px] leading-relaxed text-zinc-500">
                  웹 버전은 AI 엔진 대신 고품질 단계별 리샘플링으로 확대합니다.
                </p>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-zinc-500" title="이미지 성격에 맞는 AI 엔진">
                    엔진
                  </span>
                  {(
                    [
                      { v: 'general', l: '일반 사진', tip: '사진·그래픽 범용 (RealESRGAN x4)' },
                      {
                        v: 'anime',
                        l: '일러스트·애니',
                        tip: '라인아트·애니메이션 계열 (AnimeVideo-v3 x4)'
                      }
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.v}
                      type="button"
                      title={item.tip}
                      onClick={() => setEngine(item.v)}
                      className={`flex-1 rounded-md border py-1.5 text-[11px] transition-colors active:scale-95 ${
                        engine === item.v
                          ? 'border-indigo-500 bg-indigo-500/15 text-indigo-300'
                          : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-800'
                      }`}
                    >
                      {item.l}
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* ④ 예상 정보 */}
            <section className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-3">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                ④ 예상 결과
              </span>
              {plan === null || plan === 'invalid' ? (
                <p className="text-xs text-zinc-500">크기를 입력하면 예상 결과가 표시돼요</p>
              ) : (
                <div className="flex flex-col gap-1 text-xs tabular-nums text-zinc-300">
                  <p>
                    최종{' '}
                    <span className="font-semibold text-zinc-100">
                      {plan.target.width}×{plan.target.height}px
                    </span>
                    {unit === 'cm' && (
                      <span className="text-zinc-500">
                        {' '}
                        ({widthCm}×{heightCm}cm @ {dpi}DPI)
                      </span>
                    )}
                  </p>
                  <p>
                    원본 대비{' '}
                    <span className="font-semibold text-zinc-100">약 {plan.totalScale}배</span> ·{' '}
                    {chainSummary(plan.chain)} ({plan.chain.length}단계
                    {plan.aiUsed ? '' : ' · AI 없이 고품질 리샘플'})
                  </p>
                  <p className="text-zinc-500">
                    예상 메모리 약 {Math.round(plan.estimatedMemoryMb)}MB · 예상 파일 크기 약{' '}
                    {estimateFileSizeMb(
                      format,
                      quality,
                      info.bytes,
                      (info.width * info.height) / 1_000_000,
                      (plan.target.width * plan.target.height) / 1_000_000
                    ).toFixed(1)}
                    MB
                  </p>
                  <p className="text-zinc-500">
                    {msPerMpx !== null && plan.aiUsed
                      ? `예상 시간 ${formatDuration(msPerMpx * ((plan.target.width * plan.target.height) / 1_000_000))}`
                      : '예상 시간은 첫 AI 처리 후 표시돼요'}
                  </p>
                </div>
              )}
              {plan !== null && plan !== 'invalid' && plan.warnings.length > 0 && (
                <div className="flex flex-col gap-1">
                  {plan.warnings.map((code) => (
                    <p
                      key={code}
                      className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-300"
                    >
                      <TriangleAlert size={12} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                      {WARNING_TEXT[code]}
                    </p>
                  ))}
                </div>
              )}
              {plan !== null &&
                plan !== 'invalid' &&
                plan.warnings.includes('WARN_RATIO_MISMATCH') && (
                  <label className="text-[10px] text-zinc-500">
                    비율 처리 방식
                    <select
                      value={fitMode}
                      onChange={(e) => setFitMode(e.target.value as FitMode)}
                      className="mt-0.5 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500"
                    >
                      {FIT_MODES.map((mode) => (
                        <option key={mode.value} value={mode.value}>
                          {mode.label} — {mode.desc}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
            </section>

            {/* 고급 — 출력 포맷 */}
            <details className="text-[11px] text-zinc-400">
              <summary className="cursor-pointer select-none hover:text-zinc-200">
                저장 포맷 (고급)
              </summary>
              <div className="mt-2 flex items-center gap-1.5">
                {FORMATS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() => setFormat(f.value)}
                    className={`flex-1 rounded-md border py-1.5 text-[11px] transition-colors active:scale-95 ${
                      format === f.value
                        ? 'border-indigo-500 bg-indigo-500/15 text-indigo-300'
                        : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-800'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {format !== 'png' && (
                <label className="mt-2 block">
                  품질 {Math.round(quality * 100)}%
                  <input
                    type="range"
                    min={0.5}
                    max={1}
                    step={0.05}
                    value={quality}
                    onChange={(e) => setQuality(Number(e.target.value))}
                    className="mt-1 w-full accent-indigo-500"
                  />
                </label>
              )}
              <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">
                DPI 정보가 결과 파일에 포함되어 인쇄 프로그램에서 실제 cm 크기로 인식돼요. 투명
                배경은 PNG·WebP에서만 보존됩니다.
              </p>
            </details>

            {error && (
              <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-300">
                {error}
              </p>
            )}
            {resumableRun !== null && (
              <button
                type="button"
                onClick={resume}
                title="취소·실패 당시 완료된 단계의 결과부터 이어서 처리합니다"
                className="flex w-full items-center justify-center gap-2 rounded-md border border-amber-500/60 bg-amber-500/15 py-2 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/25 active:scale-95"
              >
                마지막 완료 단계부터 이어서 처리 ({resumableRun.skipSteps}/{resumableRun.totalSteps}
                단계 완료)
              </button>
            )}
          </div>
        )}

        {!running && info && (
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-95"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={options === null}
              className="rounded-md bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
            >
              업스케일 시작
            </button>
          </div>
        )}
      </form>
    </div>
  )
}
