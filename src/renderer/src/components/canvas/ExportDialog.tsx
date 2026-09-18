import { useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  FileOutput,
  FileText,
  Image as ImageIcon,
  Layers,
  Loader2,
  TriangleAlert,
  XCircle
} from 'lucide-react'
import type { ExportProgress, ExportResult } from '../../../../types/ipc'
import {
  buildExportManifest,
  type ExportableItem,
  type ExportFormat
} from '../../../../workers/exportManifest'

/** 내보내기 다이얼로그 단계 — 설정 → 렌더(진행률) → 완료/오류 */
type ExportPhase = 'setup' | 'rendering' | 'done' | 'error'

interface ExportDialogProps {
  /** 씬 항목 — PlacedImage를 구조적으로 만족(순수 데이터만) */
  items: readonly ExportableItem[]
  widthPx: number
  heightPx: number
  onClose: () => void
}

/**
 * 내보내기 다이얼로그 (S6 세션 2) — 포맷(PSD/PNG)·병합 옵션(F8) 선택 후
 * 사이드카 렌더를 진행률과 함께 보여준다. 진행률은 export:progress 이벤트
 * (메인 → 렌더러 push)로 수신한다. 렌더 중에는 실수로 닫히지 않게
 * Esc·백드롭 닫기를 비활성화하고 취소 버튼만 제공한다.
 */
export function ExportDialog({
  items,
  widthPx,
  heightPx,
  onClose
}: ExportDialogProps): React.JSX.Element {
  const [phase, setPhase] = useState<ExportPhase>('setup')
  const [format, setFormat] = useState<ExportFormat>('psd')
  const [flatten, setFlatten] = useState(true)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 취소로 발생한 거부는 오류 안내 없이 설정 단계로 돌린다 */
  const cancelRequestedRef = useRef(false)

  useEffect(() => {
    return window.api.onExportProgress((p) => setProgress(p))
  }, [])

  useEffect(() => {
    if (phase !== 'rendering') return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') e.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [phase])

  const handleExport = async (): Promise<void> => {
    const outputPath = await window.api.exportSaveDialog(format)
    if (!outputPath) return
    cancelRequestedRef.current = false
    setProgress(null)
    setError(null)
    setPhase('rendering')
    try {
      const manifest = buildExportManifest({
        outputPath,
        widthPx,
        heightPx,
        items,
        format,
        flatten: format === 'psd' && flatten
      })
      setResult(await window.api.exportDocument(manifest))
      setPhase('done')
    } catch (err) {
      if (cancelRequestedRef.current) {
        setPhase('setup')
        return
      }
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }

  const handleCancel = async (): Promise<void> => {
    cancelRequestedRef.current = true
    await window.api.cancelExport()
  }

  const rendering = phase === 'rendering'
  const progressPercent =
    progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-zinc-950/70 backdrop-blur-[2px]"
      onMouseDown={rendering ? undefined : onClose}
      role="dialog"
      aria-label="내보내기"
    >
      <form
        className="min-w-[380px] rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (phase === 'setup' && items.length > 0) void handleExport()
        }}
      >
        <div className="mb-3 flex items-center gap-2">
          <FileOutput size={16} strokeWidth={1.5} className="text-zinc-400" />
          <h2 className="text-sm font-semibold text-zinc-100">내보내기</h2>
        </div>

        {phase === 'setup' && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <label className="cursor-pointer">
                <input
                  type="radio"
                  name="export-format"
                  checked={format === 'psd'}
                  onChange={() => setFormat('psd')}
                  className="sr-only"
                />
                <div
                  className={`flex flex-col gap-0.5 rounded-md border p-2.5 transition-colors ${
                    format === 'psd'
                      ? 'border-indigo-500 bg-indigo-500/15'
                      : 'border-zinc-800 bg-zinc-950 hover:bg-zinc-800'
                  }`}
                >
                  <span
                    className={`flex items-center gap-1.5 text-sm font-semibold ${
                      format === 'psd' ? 'text-indigo-300' : 'text-zinc-200'
                    }`}
                  >
                    <Layers size={14} strokeWidth={1.5} />
                    PSD
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    {window.api.exportColorMode ?? 'CMYK'} · 350 DPI
                  </span>
                </div>
              </label>
              <label className="cursor-pointer">
                <input
                  type="radio"
                  name="export-format"
                  checked={format === 'png'}
                  onChange={() => setFormat('png')}
                  className="sr-only"
                />
                <div
                  className={`flex flex-col gap-0.5 rounded-md border p-2.5 transition-colors ${
                    format === 'png'
                      ? 'border-indigo-500 bg-indigo-500/15'
                      : 'border-zinc-800 bg-zinc-950 hover:bg-zinc-800'
                  }`}
                >
                  <span
                    className={`flex items-center gap-1.5 text-sm font-semibold ${
                      format === 'png' ? 'text-indigo-300' : 'text-zinc-200'
                    }`}
                  >
                    <ImageIcon size={14} strokeWidth={1.5} />
                    PNG
                  </span>
                  <span className="text-[10px] text-zinc-500">알파 검수용</span>
                </div>
              </label>
              <label className="cursor-pointer">
                <input
                  type="radio"
                  name="export-format"
                  checked={format === 'pdf'}
                  onChange={() => setFormat('pdf')}
                  className="sr-only"
                />
                <div
                  className={`flex flex-col gap-0.5 rounded-md border p-2.5 transition-colors ${
                    format === 'pdf'
                      ? 'border-indigo-500 bg-indigo-500/15'
                      : 'border-zinc-800 bg-zinc-950 hover:bg-zinc-800'
                  }`}
                >
                  <span
                    className={`flex items-center gap-1.5 text-sm font-semibold ${
                      format === 'pdf' ? 'text-indigo-300' : 'text-zinc-200'
                    }`}
                  >
                    <FileText size={14} strokeWidth={1.5} />
                    PDF
                  </span>
                  <span className="text-[10px] text-zinc-500">인쇄 검수용</span>
                </div>
              </label>
            </div>
            {format === 'psd' && (
              <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-xs text-zinc-300 transition-colors hover:text-zinc-100">
                <input
                  type="checkbox"
                  checked={flatten}
                  onChange={(e) => setFlatten(e.target.checked)}
                  className="size-3.5 accent-indigo-500"
                />
                단일 인쇄 레이어로 병합
              </label>
            )}
            <p className="my-3 text-xs tabular-nums text-zinc-400">
              배치 항목 {items.length}개 · 캔버스 {widthPx.toLocaleString()} ×{' '}
              {heightPx.toLocaleString()} px
              {items.length === 0 && (
                <span className="inline-flex items-center gap-1 font-medium text-red-400">
                  <TriangleAlert size={12} strokeWidth={1.5} />— 배치된 이미지가 없습니다
                </span>
              )}
            </p>
          </>
        )}

        {rendering && (
          <div className="my-3 flex flex-col gap-2">
            <div className="h-2 overflow-hidden rounded-full border border-zinc-800 bg-zinc-950">
              <div
                className="h-full bg-indigo-500 transition-all duration-150"
                style={{ width: `${progress?.stage === 'write' ? 100 : progressPercent}%` }}
              />
            </div>
            <p className="flex items-center gap-1.5 text-xs tabular-nums text-zinc-400">
              <Loader2 size={12} strokeWidth={1.5} className="animate-spin text-indigo-400" />
              {progress?.stage === 'write'
                ? '파일 저장 중…'
                : `항목 렌더 ${progress?.current ?? 0} / ${progress?.total ?? items.length}`}
            </p>
          </div>
        )}

        {phase === 'done' && result && (
          <p className="my-3 flex flex-col gap-1.5 text-xs tabular-nums text-zinc-300">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 size={14} strokeWidth={1.5} className="text-emerald-400" />
              완료 — {result.width_px.toLocaleString()} × {result.height_px.toLocaleString()} px ·
              레이어 {result.layer_count} · {(result.duration_ms / 1000).toFixed(1)}초
            </span>
            <span className="break-all text-[10px] font-normal text-zinc-500">
              {result.output_path}
            </span>
          </p>
        )}

        {phase === 'error' && error && (
          <p className="my-3 flex items-start gap-1.5 whitespace-pre-wrap break-all text-xs text-red-400">
            <XCircle size={14} strokeWidth={1.5} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          {rendering ? (
            <button
              type="button"
              onClick={() => void handleCancel()}
              className="rounded-md border border-zinc-800 bg-zinc-950 px-3.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-95"
            >
              취소
            </button>
          ) : phase === 'done' ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 active:scale-95"
            >
              닫기
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-zinc-800 bg-zinc-950 px-3.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-95"
              >
                닫기
              </button>
              <button
                type="submit"
                disabled={items.length === 0}
                className="rounded-md bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {phase === 'error' ? '다시 시도' : '내보내기'}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  )
}
