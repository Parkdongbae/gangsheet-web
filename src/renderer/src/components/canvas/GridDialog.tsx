import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Grid3x3, TriangleAlert } from 'lucide-react'
import { cmToPx } from '../../../../core/math'
import type { GridSource } from './placement'

/** 행×열 상한 — 프록시 씬 노드 수 폭주 방지 (50×50 = 2,500개) */
const MAX_GRID = 50
const GAP_CM_MAX = 50

interface GridDialogProps {
  /** 복제 기준 항목 — 셀 (0,0)이 이 항목의 자리가 된다 */
  item: GridSource
  /** 문서 가로 (350 DPI px) — 가로·전체 채우기 및 범위 초과 경고 기준 */
  widthPx: number
  /** 문서 세로 (350 DPI px) — 세로·전체 채우기 기준 */
  heightPx: number
  onConfirm: (rows: number, cols: number, gapPx: number) => void
  onClose: () => void
}

const parseIntFallback = (text: string, min: number, max: number, fallback: number): number => {
  const n = Number.parseInt(text, 10)
  if (Number.isNaN(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

const parseGapCm = (text: string): number => {
  const n = Number.parseFloat(text)
  if (Number.isNaN(n)) return 1
  return Math.min(Math.max(n, 0), GAP_CM_MAX)
}

const INPUT_CLASS =
  'w-full bg-transparent px-2 py-1.5 text-sm tabular-nums text-zinc-200 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

/** 축 전체에 들어가는 복제 개수 — (전체 길이 + 간격) ÷ (항목 + 간격), 상한·최소 1 클램프 */
const fitCount = (totalPx: number, sizePx: number, gapPx: number): number =>
  Math.min(MAX_GRID, Math.max(1, Math.floor((totalPx + gapPx) / (sizePx + gapPx))))

/** 숫자 입력 + 증감(▲▼) 버튼 — step<1이면 소수 1자리로 표기한다 */
function StepperField({
  label,
  value,
  min,
  max,
  step,
  unit,
  autoFocus = false,
  onChange
}: {
  label: string
  value: string
  min: number
  max: number
  step: number
  unit: string
  autoFocus?: boolean
  onChange: (text: string) => void
}): React.JSX.Element {
  const stepBy = (dir: 1 | -1): void => {
    const base = Number.parseFloat(value)
    const next = Math.min(Math.max((Number.isNaN(base) ? min : base) + dir * step, min), max)
    onChange(step < 1 ? next.toFixed(1) : String(Math.round(next)))
  }
  const spinnerClass =
    'flex flex-1 items-center justify-center px-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100 active:bg-zinc-700'
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      <div className="flex items-stretch rounded-md border border-zinc-800 bg-zinc-950 transition-all focus-within:ring-1 focus-within:ring-indigo-500">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_CLASS}
        />
        <span className="flex items-center px-1.5 text-[11px] text-zinc-500">{unit}</span>
        <span className="flex flex-col border-l border-zinc-800">
          <button
            type="button"
            onClick={() => stepBy(1)}
            aria-label={`${label} 증가`}
            title={`${label} 증가`}
            className={spinnerClass}
          >
            <ChevronUp size={10} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => stepBy(-1)}
            aria-label={`${label} 감소`}
            title={`${label} 감소`}
            className={`${spinnerClass} border-t border-zinc-800`}
          >
            <ChevronDown size={10} strokeWidth={2} />
          </button>
        </span>
      </div>
    </label>
  )
}

/** 그리드 복제 대화상자 (S5 세션 2) — 행×열·간격(cm)을 받아 절대 px gap으로 확정 커밋 */
export function GridDialog({
  item,
  widthPx,
  heightPx,
  onConfirm,
  onClose
}: GridDialogProps): React.JSX.Element {
  const [rowsText, setRowsText] = useState('2')
  const [colsText, setColsText] = useState('2')
  const [gapText, setGapText] = useState('1')

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const rows = parseIntFallback(rowsText, 1, MAX_GRID, 2)
  const cols = parseIntFallback(colsText, 1, MAX_GRID, 2)
  const gapCm = parseGapCm(gapText)
  const gapPx = cmToPx(gapCm)
  const total = rows * cols
  // 결과 그리드 범위 (350 DPI px → cm) — 롤 폭 50cm 초과 시 경고
  const extentCm = {
    w: ((cols * item.widthPx + (cols - 1) * gapPx) / 350) * 2.54,
    h: ((rows * item.heightPx + (rows - 1) * gapPx) / 350) * 2.54
  }
  const overRoll = cols * item.widthPx + (cols - 1) * gapPx > widthPx

  /** 현재 간격 기준으로 각 축을 채우는 개수를 입력에 반영 — 적용은 사용자가 확정 */
  const fillRow = (): void => {
    setRowsText('1')
    setColsText(String(fitCount(widthPx, item.widthPx, gapPx)))
  }
  const fillCol = (): void => {
    setRowsText(String(fitCount(heightPx, item.heightPx, gapPx)))
    setColsText('1')
  }
  const fillAll = (): void => {
    setRowsText(String(fitCount(heightPx, item.heightPx, gapPx)))
    setColsText(String(fitCount(widthPx, item.widthPx, gapPx)))
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center dtf-scrim"
      onMouseDown={onClose}
    >
      <form
        className="min-w-[340px] rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-2xl"
        role="dialog"
        aria-label="이미지 복제"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          onConfirm(rows, cols, gapPx)
        }}
      >
        <div className="mb-3 flex items-center gap-2">
          <Grid3x3 size={16} strokeWidth={1.5} className="text-zinc-400" />
          <h2 className="text-sm font-semibold text-zinc-100">이미지 복제</h2>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <StepperField
            label="행"
            value={rowsText}
            min={1}
            max={MAX_GRID}
            step={1}
            unit="개"
            autoFocus
            onChange={setRowsText}
          />
          <StepperField
            label="열"
            value={colsText}
            min={1}
            max={MAX_GRID}
            step={1}
            unit="개"
            onChange={setColsText}
          />
          <StepperField
            label="간격"
            value={gapText}
            min={0}
            max={GAP_CM_MAX}
            step={0.5}
            unit="cm"
            onChange={setGapText}
          />
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={fillRow}
            title="문서 가로 폭을 기준으로 한 줄 복제 개수 계산"
            className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 active:scale-95"
          >
            가로방향
          </button>
          <button
            type="button"
            onClick={fillCol}
            title="문서 세로 길이를 기준으로 한 줄 복제 개수 계산"
            className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 active:scale-95"
          >
            세로방향
          </button>
          <button
            type="button"
            onClick={fillAll}
            title="문서 전체를 채우는 행×열 개수 계산 (상한 50×50)"
            className="rounded-md border border-indigo-500 bg-indigo-500/15 px-2 py-1.5 text-xs font-medium text-indigo-300 transition-colors hover:bg-indigo-500/25 active:scale-95"
          >
            전체 채우기
          </button>
        </div>
        <p className="my-3 text-xs tabular-nums text-zinc-400">
          총 {total}개 (신규 {total - 1}개 복제) · 결과 {extentCm.w.toFixed(1)} ×{' '}
          {extentCm.h.toFixed(1)} cm
          {overRoll && (
            <span className="inline-flex items-center gap-1 font-semibold text-red-400">
              <TriangleAlert size={12} strokeWidth={1.5} />— 문서 폭 초과!
            </span>
          )}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-800 bg-zinc-950 px-3.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-95"
          >
            취소
          </button>
          <button
            type="submit"
            className="rounded-md bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 active:scale-95"
          >
            적용
          </button>
        </div>
      </form>
    </div>
  )
}
