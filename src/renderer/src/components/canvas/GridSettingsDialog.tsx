import { useEffect, useState } from 'react'
import { Check, Grid2x2 } from 'lucide-react'
import {
  GRID_COLOR_PRESETS,
  GRID_INTERVAL_MAX_CM,
  GRID_INTERVAL_MIN_CM,
  GRID_LINE_STYLES,
  GRID_STYLE_LABELS,
  clampGridIntervalCm,
  type GridLineStyle,
  type GridSettings
} from './gridOverlay'

const INPUT_CLASS =
  'w-full bg-transparent px-2 py-1.5 text-sm tabular-nums text-zinc-200 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

interface GridSettingsDialogProps {
  settings: GridSettings
  /** 변경 즉시 반영(라이브 프리뷰) — 그리드는 보기 옵션이라 히스토리 없음 */
  onChange: (next: GridSettings) => void
  onClose: () => void
}

/** 그리드 표시 설정 — 간격(cm)·색상·선 스타일을 실시간으로 캔버스에 반영 */
export function GridSettingsDialog({
  settings,
  onChange,
  onClose
}: GridSettingsDialogProps): React.JSX.Element {
  const [intervalText, setIntervalText] = useState(String(settings.intervalCm))

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const applyInterval = (text: string): void => {
    setIntervalText(text)
    const parsed = Number.parseFloat(text)
    if (Number.isNaN(parsed)) return
    onChange({ ...settings, intervalCm: clampGridIntervalCm(parsed) })
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center dtf-scrim"
      onMouseDown={onClose}
    >
      <form
        className="min-w-[340px] rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-2xl"
        role="dialog"
        aria-label="그리드 표시 설정"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          onClose()
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Grid2x2 size={16} strokeWidth={1.5} className="text-zinc-400" />
            <h2 className="text-sm font-semibold text-zinc-100">그리드 표시</h2>
          </div>
          <button
            type="button"
            onClick={() => onChange({ ...settings, visible: !settings.visible })}
            role="switch"
            aria-checked={settings.visible}
            aria-label="그리드 표시 토글"
            className={`relative h-5 w-9 rounded-full transition-colors ${
              settings.visible ? 'bg-indigo-600' : 'bg-zinc-700'
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                settings.visible ? 'left-[18px]' : 'left-0.5'
              }`}
            />
          </button>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            간격 ({GRID_INTERVAL_MIN_CM}~{GRID_INTERVAL_MAX_CM} cm)
          </span>
          <div className="flex items-center rounded-md border border-zinc-800 bg-zinc-950 transition-all focus-within:ring-1 focus-within:ring-indigo-500">
            <input
              type="number"
              min={GRID_INTERVAL_MIN_CM}
              max={GRID_INTERVAL_MAX_CM}
              step={0.5}
              value={intervalText}
              onChange={(e) => applyInterval(e.target.value)}
              onBlur={() => setIntervalText(String(settings.intervalCm))}
              className={INPUT_CLASS}
            />
            <span className="px-2 text-[11px] text-zinc-500">cm</span>
          </div>
        </label>

        <div className="mt-3 flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            색상
          </span>
          <div className="flex items-center gap-1.5">
            {GRID_COLOR_PRESETS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => onChange({ ...settings, color })}
                aria-label={`색상 ${color}`}
                className={`flex h-6 w-6 items-center justify-center rounded-md border transition-transform active:scale-90 ${
                  settings.color.toLowerCase() === color.toLowerCase()
                    ? 'border-indigo-400 ring-1 ring-indigo-500'
                    : 'border-zinc-700 hover:border-zinc-500'
                }`}
                style={{ backgroundColor: color }}
              >
                {settings.color.toLowerCase() === color.toLowerCase() && (
                  <Check
                    size={12}
                    strokeWidth={2}
                    className={
                      color === '#000000' ? 'text-zinc-300' : 'text-zinc-100 mix-blend-difference'
                    }
                  />
                )}
              </button>
            ))}
            <label
              className="relative ml-1 flex h-6 w-6 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-zinc-700 transition-transform active:scale-90"
              title="사용자 지정 색"
              style={{
                background:
                  'conic-gradient(from 0deg, #ef4444, #eab308, #22c55e, #3b82f6, #6366f1, #ef4444)'
              }}
            >
              <input
                type="color"
                value={settings.color}
                onChange={(e) => onChange({ ...settings, color: e.target.value })}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="사용자 지정 색"
              />
            </label>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            선 스타일
          </span>
          <div className="grid grid-cols-3 gap-1.5">
            {GRID_LINE_STYLES.map((style: GridLineStyle) => (
              <button
                key={style}
                type="button"
                onClick={() => onChange({ ...settings, lineStyle: style })}
                className={`flex flex-col items-center gap-1.5 rounded-md border p-2 transition-colors ${
                  settings.lineStyle === style
                    ? 'border-indigo-500 bg-indigo-500/15'
                    : 'border-zinc-800 bg-zinc-950 hover:bg-zinc-800'
                }`}
              >
                <span className="text-xs text-zinc-200">{GRID_STYLE_LABELS[style]}</span>
                <span
                  className="w-full border-t-4 border-zinc-400"
                  style={{
                    borderTopStyle:
                      style === 'solid' ? 'solid' : style === 'dashed' ? 'dashed' : 'dotted'
                  }}
                />
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            className="rounded-md bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 active:scale-95"
          >
            닫기
          </button>
        </div>
      </form>
    </div>
  )
}
