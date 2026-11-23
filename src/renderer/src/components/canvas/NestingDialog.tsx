import { useEffect, useMemo, useState } from 'react'
import { Boxes, TriangleAlert } from 'lucide-react'
import { pxToCm } from '../../../../core/math'
import { packImages, type NestingInput } from './autoNesting'

/** BATCH.md §1-2 — 간격 범위 0.0~10.0cm, 0.1 단위 */
const GAP_CM_MAX = 10
const GAP_CM_DEFAULT = 2

interface NestingDialogProps {
  items: readonly NestingInput[]
  widthPx: number
  heightPx: number
  onConfirm: (gapCm: number, allowRotation: boolean) => void
  onClose: () => void
}

const parseGapCm = (text: string): number => {
  const n = Number.parseFloat(text)
  if (Number.isNaN(n)) return GAP_CM_DEFAULT
  return Math.min(Math.max(n, 0), GAP_CM_MAX)
}

const INPUT_CLASS =
  'w-full bg-transparent px-2 py-1.5 text-sm tabular-nums text-zinc-200 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

/**
 * 자동 배치 대화상자 (BATCH.md) — 간격(cm)·90° 회전 옵션과 실시간 패킹 미리보기.
 * 순수 함수 packImages를 매 렌더 재계산해 사용 높이·효율·미배치를 즉시 보여준다.
 */
export function NestingDialog({
  items,
  widthPx,
  heightPx,
  onConfirm,
  onClose
}: NestingDialogProps): React.JSX.Element {
  const [gapText, setGapText] = useState('2.0')
  const [allowRotation, setAllowRotation] = useState(true)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const gapCm = parseGapCm(gapText)
  const preview = useMemo(
    () =>
      packImages(items, {
        canvasWidthPx: widthPx,
        canvasHeightPx: heightPx,
        gapCm,
        dpi: 350,
        allowRotation
      }),
    [items, widthPx, heightPx, gapCm, allowRotation]
  )

  const usedM = pxToCm(preview.usedHeightPx) / 100
  const failed = preview.unpackedIds.length

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center dtf-scrim"
      onMouseDown={onClose}
    >
      <form
        className="min-w-[340px] rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-2xl"
        role="dialog"
        aria-label="자동 배치"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          onConfirm(gapCm, allowRotation)
        }}
      >
        <div className="mb-3 flex items-center gap-2">
          <Boxes size={16} strokeWidth={1.5} className="text-zinc-400" />
          <h2 className="text-sm font-semibold text-zinc-100">자동 배치 (MaxRects)</h2>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              이미지 간격
            </span>
            <div className="flex items-center rounded-md border border-zinc-800 bg-zinc-950 transition-all focus-within:ring-1 focus-within:ring-indigo-500">
              <input
                type="number"
                min={0}
                max={GAP_CM_MAX}
                step={0.1}
                value={gapText}
                autoFocus
                onChange={(e) => setGapText(e.target.value)}
                className={INPUT_CLASS}
              />
              <span className="px-2 text-[11px] text-zinc-500">cm</span>
            </div>
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              회전 패킹
            </span>
            <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800/60">
              <input
                type="checkbox"
                checked={allowRotation}
                onChange={(e) => setAllowRotation(e.target.checked)}
                className="size-3.5 accent-indigo-500"
              />
              90° 회전 허용
            </label>
          </div>
        </div>

        <p className="my-3 text-xs tabular-nums text-zinc-400">
          총 {items.length}개 · 배치 {preview.packedItems.length}개 · 사용 높이 {usedM.toFixed(2)} m
          ({preview.usedHeightPx.toLocaleString()} px) · 공간 효율 {preview.efficiency.toFixed(1)}%
          {failed > 0 && (
            <span className="inline-flex items-center gap-1 font-semibold text-red-400">
              <TriangleAlert size={12} strokeWidth={1.5} />— {failed}개 미배치(캔버스 초과)
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
            disabled={preview.packedItems.length === 0}
            className="rounded-md bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
          >
            적용 (Ctrl+Z 가능)
          </button>
        </div>
      </form>
    </div>
  )
}
