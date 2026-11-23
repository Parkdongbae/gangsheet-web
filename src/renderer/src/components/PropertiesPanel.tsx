import { useState } from 'react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalJustifyCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalJustifyCenter,
  ArrowDownToLine,
  ArrowUpToLine,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Copy,
  Eraser,
  ExternalLink,
  Globe,
  Grid3x3,
  Layers,
  Link2,
  Link2Off,
  Loader2,
  Lock,
  MousePointerClick,
  Move,
  RotateCw,
  Scale,
  Unlock,
  ZoomIn
} from 'lucide-react'
import { cmToPx, pxToCm } from '../../../core/math'
import type { BgRemovalMode, RemoveBgProgress } from '../../../types/ipc'
import { normalizeRotation, type LayerOrderOp } from './canvas/placement'
import type { AlignOp, DocAlignOp } from './canvas/alignment'
import type { PlacedImage } from './canvas/ProxyCanvas'

const ICON = { size: 15, strokeWidth: 1.5 } as const

export interface PropertiesPanelProps {
  item: PlacedImage | null
  itemCount: number
  selectedIndex: number | null
  /** 다중 선택 개수 — 2 이상이면 정렬 패널이 편집 패널을 대체한다 */
  multiSelectedCount: number
  /** 정렬·분배 유닛 수 — 같은 그룹은 1유닛 (분배는 3유닛 이상 가능) */
  alignUnitCount: number
  onAlign: (op: AlignOp) => void
  onDocAlign: (op: DocAlignOp) => void
  onUpdate: (patch: Partial<PlacedImage>) => void
  onRotate90: () => void
  onOrder: (op: LayerOrderOp) => void
  onToggleLock: () => void
  onOpenGrid: () => void
  onRemoveBg: () => void
  removeBusy: boolean
  /** 배경 제거 배치 진행률 — 처리 중 n/N 표기(완료분은 캔버스에 즉시 반영) */
  removeProgress: { current: number; total: number } | null
  /** 배경 제거 사이트 다이얼로그 열기 */
  onOpenBgSites: () => void
  /** 선택 가능한 배경 제거 방식 — 없으면(데스크톱) 선택 UI 숨김 */
  bgModes?: readonly BgRemovalMode[]
  bgMode: BgRemovalMode
  onBgMode: (mode: BgRemovalMode) => void
  /** 배경 제거 세부 단계 — 모델 다운로드 % 등 */
  bgStage: RemoveBgProgress | null
  /** 업스케일 다이얼로그 열기 — 단일 선택 편집 패널에서만 노출 */
  onOpenUpscale: () => void
}

function Section({
  title,
  icon,
  children,
  defaultOpen = true
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-zinc-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2.5 text-zinc-200 transition-colors hover:bg-zinc-800"
      >
        <span className="flex items-center gap-2">
          <span className="text-zinc-400">{icon}</span>
          <span className="text-xs font-medium uppercase tracking-wide">{title}</span>
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.5}
          className={`text-zinc-500 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && <div className="px-3 pb-4 pt-1">{children}</div>}
    </div>
  )
}

/**
 * 수치 입력 필드 — 포커스 중 로컬 드래프트 편집, blur/Enter 시에만 커밋.
 * display는 확정 상태에서의 표시 문자열(포맷팅은 호출자 담당).
 */
function NumField({
  label,
  unit,
  display,
  onCommit
}: {
  label: string
  unit: string
  display: string
  onCommit: (valueCm: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const editing = draft !== null

  const commit = (): void => {
    if (draft === null) return
    const parsed = Number.parseFloat(draft)
    setDraft(null)
    if (Number.isFinite(parsed)) onCommit(parsed)
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </label>
      <div
        className={`flex items-center rounded-md border bg-zinc-950 transition-all focus-within:ring-1 focus-within:ring-indigo-500 ${
          editing ? 'border-indigo-500' : 'border-zinc-800'
        }`}
      >
        <input
          type="text"
          inputMode="decimal"
          value={editing ? draft : display}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setDraft(null)
              e.currentTarget.blur()
            }
          }}
          className="w-full bg-transparent px-2 py-1.5 text-sm tabular-nums text-zinc-200 outline-none"
        />
        <span className="px-2 text-[11px] font-medium text-zinc-500">{unit}</span>
      </div>
    </div>
  )
}

function IconBtn({
  label,
  onClick,
  disabled = false,
  children
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-8 flex-1 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  )
}

const fileBaseName = (filePath: string): string => filePath.split(/[\\/]/).pop() ?? filePath

const formatCm = (px: number): string => pxToCm(px).toFixed(1)

const DOC_ALIGN_BUTTONS: ReadonlyArray<{ op: DocAlignOp; label: string }> = [
  { op: 'docLeft', label: '문서 좌측에 정렬' },
  { op: 'docCenterH', label: '문서 가로 중앙에 정렬' },
  { op: 'docRight', label: '문서 우측에 정렬' },
  { op: 'docTop', label: '문서 상단에 정렬' },
  { op: 'docCenterV', label: '문서 세로 중앙에 정렬' },
  { op: 'docBottom', label: '문서 하단에 정렬' }
]

function bgStageLabel(stage: RemoveBgProgress | null): string {
  if (!stage) return '처리 중'
  switch (stage.stage) {
    case 'download':
      return 'AI 모델 내려받는 중 (처음 한 번)'
    case 'init':
      return 'AI 준비 중'
    case 'infer':
      return '배경 분석 중'
    case 'refine':
      return '경계 다듬는 중'
    default:
      return '결과 저장 중'
  }
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `약 ${seconds}초 남음`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `약 ${minutes}분 남음` : `약 ${minutes}분 ${rest}초 남음`
}

/** 배경 제거 진행 상자 — 단계 · 전체 % · 남은 시간(웹) / 단계 정보가 없으면(데스크톱) 진행 중 표시만 */
function BgProgress({
  stage,
  batch
}: {
  stage: RemoveBgProgress | null
  batch: { current: number; total: number } | null
}): React.JSX.Element {
  const percent = stage?.percent
  const batchText =
    batch && batch.total > 1
      ? `${Math.min(batch.current + 1, batch.total)}번째 / 전체 ${batch.total}개`
      : null
  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-2 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-2"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-zinc-200">{bgStageLabel(stage)}</span>
        {percent !== undefined && (
          <span className="text-sm font-bold tabular-nums text-indigo-300">{percent}%</span>
        )}
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-800"
      >
        <div
          className={`h-full rounded-full bg-indigo-500 transition-[width] duration-300 ease-out ${
            percent === undefined ? 'w-full animate-pulse' : ''
          }`}
          style={percent === undefined ? undefined : { width: `${percent}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] tabular-nums text-zinc-500">
        <span>
          {stage?.etaSeconds !== undefined
            ? formatEta(stage.etaSeconds)
            : stage
              ? '남은 시간 계산 중…'
              : '잠시만 기다려 주세요'}
        </span>
        {batchText && <span>{batchText}</span>}
      </div>
    </div>
  )
}

const BG_MODE_LABELS: Record<BgRemovalMode, { label: string; hint: string }> = {
  ai: { label: 'AI 자동', hint: '사진 · 일러스트' },
  solid: { label: '단색 배경', hint: '로고 · 글자' }
}

function BgModePicker({
  modes,
  value,
  onChange,
  disabled
}: {
  modes: readonly BgRemovalMode[]
  value: BgRemovalMode
  onChange: (mode: BgRemovalMode) => void
  disabled: boolean
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label="배경 제거 방식" className="mb-2 grid grid-cols-2 gap-1.5">
      {modes.map((mode) => {
        const active = mode === value
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(mode)}
            className={`flex flex-col items-center rounded-md border px-2 py-1.5 transition-colors disabled:pointer-events-none disabled:opacity-40 ${
              active
                ? 'border-indigo-500 bg-indigo-500/15 text-indigo-300'
                : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            <span className="text-xs font-semibold">{BG_MODE_LABELS[mode].label}</span>
            <span className="text-[11px] text-zinc-500">{BG_MODE_LABELS[mode].hint}</span>
          </button>
        )
      })}
    </div>
  )
}

export function PropertiesPanel({
  item,
  itemCount,
  selectedIndex,
  multiSelectedCount,
  alignUnitCount,
  onAlign,
  onDocAlign,
  onUpdate,
  onRotate90,
  onOrder,
  onToggleLock,
  onOpenGrid,
  onRemoveBg,
  removeBusy,
  removeProgress,
  onOpenBgSites,
  bgModes,
  bgMode,
  onBgMode,
  bgStage,
  onOpenUpscale
}: PropertiesPanelProps): React.JSX.Element {
  const [linked, setLinked] = useState(true)
  const multi = !item && multiSelectedCount >= 2
  const canDistribute = alignUnitCount >= 3
  /** 진행 중 라벨 — 배치면 n/N, 단일이면 스피너만 */
  const removeBusyLabel = '처리 중…'
  const bgProgress = removeBusy ? <BgProgress stage={bgStage} batch={removeProgress} /> : null
  const bgModePicker =
    bgModes && bgModes.length > 1 ? (
      <BgModePicker modes={bgModes} value={bgMode} onChange={onBgMode} disabled={removeBusy} />
    ) : null
  const bgHelp = !bgModes
    ? 'AI가 피사체를 인식해 배경을 투명하게 만듭니다. 기본 모델이 앱에 포함되어 있어 오프라인에서도 바로 동작합니다.'
    : bgMode === 'solid'
      ? '가장자리와 이어진 한 가지 색 배경만 지웁니다. 흰 바탕의 로고·글자처럼 경계가 또렷한 그림에 알맞습니다.'
      : 'AI가 사람·사물을 알아보고 배경을 지웁니다. 처음 한 번만 AI 모델(85~170MB)을 내려받으며, 이미지는 내 컴퓨터 밖으로 나가지 않습니다.'

  const commitWidth = (valueCm: number): void => {
    if (!item || valueCm <= 0) return
    const widthPx = cmToPx(valueCm)
    onUpdate(linked ? { widthPx, heightPx: (item.heightPx * widthPx) / item.widthPx } : { widthPx })
  }

  const commitHeight = (valueCm: number): void => {
    if (!item || valueCm <= 0) return
    const heightPx = cmToPx(valueCm)
    onUpdate(
      linked ? { heightPx, widthPx: (item.widthPx * heightPx) / item.heightPx } : { heightPx }
    )
  }

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-3">
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-zinc-100">속성</span>
          <span className="max-w-[180px] truncate text-[11px] text-zinc-500">
            {multi
              ? `${multiSelectedCount}개 다중 선택`
              : item
                ? fileBaseName(item.filePath)
                : '선택 없음'}
          </span>
        </div>
        <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-500">
          {itemCount}개
        </span>
      </div>

      {multi ? (
        <div className="flex-1 overflow-y-auto">
          <Section
            title="정렬"
            icon={<AlignCenterVertical size={ICON.size} strokeWidth={ICON.strokeWidth} />}
          >
            <div className="grid grid-cols-3 gap-1.5">
              <IconBtn label="좌측 정렬" onClick={() => onAlign('left')}>
                <AlignStartVertical size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
              <IconBtn label="가로 중앙 정렬" onClick={() => onAlign('centerH')}>
                <AlignCenterVertical size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
              <IconBtn label="우측 정렬" onClick={() => onAlign('right')}>
                <AlignEndVertical size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
              <IconBtn label="상단 정렬" onClick={() => onAlign('top')}>
                <AlignStartHorizontal size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
              <IconBtn label="세로 중앙 정렬" onClick={() => onAlign('centerV')}>
                <AlignCenterHorizontal size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
              <IconBtn label="하단 정렬" onClick={() => onAlign('bottom')}>
                <AlignEndHorizontal size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <IconBtn
                label="수평 간격 균등 분배 (그룹 포함 3유닛 이상)"
                onClick={() => onAlign('distH')}
                disabled={!canDistribute}
              >
                <AlignHorizontalJustifyCenter size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
              <IconBtn
                label="수직 간격 균등 분배 (그룹 포함 3유닛 이상)"
                onClick={() => onAlign('distV')}
                disabled={!canDistribute}
              >
                <AlignVerticalJustifyCenter size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
            </div>
            <div className="mt-3 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              문서 기준 (선택 전체)
            </div>
            <div className="mt-1 grid grid-cols-3 gap-1.5">
              {DOC_ALIGN_BUTTONS.map(({ op, label }) => (
                <IconBtn key={op} label={label} onClick={() => onDocAlign(op)}>
                  {op === 'docLeft' ? (
                    <AlignStartVertical size={ICON.size} strokeWidth={ICON.strokeWidth} />
                  ) : op === 'docCenterH' ? (
                    <AlignCenterVertical size={ICON.size} strokeWidth={ICON.strokeWidth} />
                  ) : op === 'docRight' ? (
                    <AlignEndVertical size={ICON.size} strokeWidth={ICON.strokeWidth} />
                  ) : op === 'docTop' ? (
                    <AlignStartHorizontal size={ICON.size} strokeWidth={ICON.strokeWidth} />
                  ) : op === 'docCenterV' ? (
                    <AlignCenterHorizontal size={ICON.size} strokeWidth={ICON.strokeWidth} />
                  ) : (
                    <AlignEndHorizontal size={ICON.size} strokeWidth={ICON.strokeWidth} />
                  )}
                </IconBtn>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              {multiSelectedCount}개 항목을 회전된 표시 영역 기준으로 정렬합니다. 그룹은 하나의
              단위로 움직여 내부 배치가 유지되고, 간격 분배는 그룹 포함 3유닛 이상부터 가능합니다.
              문서 기준은 선택 전체를 문서 가장자리·중앙에 맞춥니다. 모든 정렬은 Ctrl+Z로 되돌릴 수
              있습니다.
            </p>
          </Section>
          <Section
            title="레이어 순서"
            icon={<Layers size={ICON.size} strokeWidth={ICON.strokeWidth} />}
          >
            <div className="grid grid-cols-4 gap-1.5">
              <IconBtn
                label={`맨 앞으로 (${multiSelectedCount}개)`}
                onClick={() => onOrder('front')}
              >
                <ArrowUpToLine size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
              <IconBtn
                label={`앞으로 (${multiSelectedCount}개)`}
                onClick={() => onOrder('forward')}
              >
                <ChevronUp size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
              <IconBtn label={`뒤로 (${multiSelectedCount}개)`} onClick={() => onOrder('backward')}>
                <ChevronDown size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
              <IconBtn label={`맨 뒤로 (${multiSelectedCount}개)`} onClick={() => onOrder('back')}>
                <ArrowDownToLine size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              선택 {multiSelectedCount}개의 상대 레이어 순서를 유지한 채 통째로 이동합니다.
            </p>
          </Section>
          <Section
            title="배경 제거"
            icon={<Eraser size={ICON.size} strokeWidth={ICON.strokeWidth} />}
          >
            {bgModePicker}
            <button
              type="button"
              onClick={onRemoveBg}
              disabled={removeBusy}
              title={`배경 제거 (${multiSelectedCount}개)`}
              aria-label={`배경 제거 (${multiSelectedCount}개)`}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-indigo-500 bg-indigo-500/15 py-2 text-xs font-medium text-indigo-300 transition-colors hover:bg-indigo-500/25 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
            >
              {removeBusy ? (
                <Loader2 size={ICON.size} strokeWidth={ICON.strokeWidth} className="animate-spin" />
              ) : (
                <Eraser size={ICON.size} strokeWidth={ICON.strokeWidth} />
              )}
              {removeBusy ? removeBusyLabel : `배경 제거 (${multiSelectedCount}개)`}
            </button>
            {bgProgress}
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              선택한 {multiSelectedCount}개를 차례로 처리합니다. {bgHelp} 전체를 Ctrl+Z 한 번으로
              되돌릴 수 있습니다.
            </p>
            <button
              type="button"
              onClick={onOpenBgSites}
              title="결과가 마음에 들지 않을 때 쓸 수 있는 무료 배경 제거 사이트 모음"
              className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-[0.98]"
            >
              <Globe size={13} strokeWidth={1.5} className="text-zinc-400" />
              다른 배경 제거 사이트 보기
            </button>
          </Section>
          <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
            <MousePointerClick size={20} strokeWidth={1.5} className="text-zinc-600" />
            <span className="text-xs text-zinc-500">
              {multiSelectedCount}개 항목이 선택되었습니다
            </span>
            <span className="text-[11px] text-zinc-600">
              드래그하면 함께 이동하고 · Ctrl+클릭으로 개별 해제 · 1개만 남기면 수치 편집이
              가능합니다
            </span>
          </div>
        </div>
      ) : !item ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <MousePointerClick size={20} strokeWidth={1.5} className="text-zinc-600" />
          <span className="text-xs text-zinc-500">선택된 항목 없음</span>
          <span className="text-[11px] text-zinc-600">
            캔버스에서 이미지를 클릭하면 위치·크기·레이어를 편집할 수 있습니다
          </span>
          <button
            type="button"
            onClick={onOpenBgSites}
            title="결과가 마음에 들지 않을 때 쓸 수 있는 무료 배경 제거 사이트 모음"
            className="mt-3 flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-[0.98]"
          >
            <Globe size={13} strokeWidth={1.5} className="text-zinc-400" />
            다른 배경 제거 사이트 보기
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto" key={item.id}>
          <Section
            title="위치 / 크기"
            icon={<Move size={ICON.size} strokeWidth={ICON.strokeWidth} />}
          >
            <div className="grid grid-cols-2 gap-2">
              <NumField
                label="X"
                unit="cm"
                display={formatCm(item.x)}
                onCommit={(v) => onUpdate({ x: cmToPx(v) })}
              />
              <NumField
                label="Y"
                unit="cm"
                display={formatCm(item.y)}
                onCommit={(v) => onUpdate({ y: cmToPx(v) })}
              />
            </div>

            <div className="mt-2 flex items-end gap-1.5">
              <div className="flex-1">
                <NumField
                  label="가로"
                  unit="cm"
                  display={formatCm(item.widthPx)}
                  onCommit={commitWidth}
                />
              </div>
              <button
                type="button"
                onClick={() => setLinked((v) => !v)}
                title={linked ? '비율 고정 해제' : '비율 고정'}
                aria-label={linked ? '비율 고정 해제' : '비율 고정'}
                className={`mb-1 flex h-8 w-7 items-center justify-center rounded-md border transition-colors active:scale-95 ${
                  linked
                    ? 'border-indigo-500 bg-indigo-500/15 text-indigo-300'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                {linked ? (
                  <Link2 size={14} strokeWidth={1.5} />
                ) : (
                  <Link2Off size={14} strokeWidth={1.5} />
                )}
              </button>
              <div className="flex-1">
                <NumField
                  label="세로"
                  unit="cm"
                  display={formatCm(item.heightPx)}
                  onCommit={commitHeight}
                />
              </div>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2">
              <NumField
                label="회전"
                unit="deg"
                display={String(Math.round(item.rotation))}
                onCommit={(v) => onUpdate({ rotation: normalizeRotation(v) })}
              />
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  변형
                </span>
                <IconBtn label="90도 회전" onClick={onRotate90} disabled={item.locked === true}>
                  <RotateCw size={ICON.size} strokeWidth={ICON.strokeWidth} />
                </IconBtn>
              </div>
            </div>

            <div className="mt-2 flex gap-1.5">
              <IconBtn
                label={item.locked ? '잠금 해제 (Ctrl+L)' : '잠금 (Ctrl+L)'}
                onClick={onToggleLock}
              >
                {item.locked ? (
                  <Unlock size={ICON.size} strokeWidth={ICON.strokeWidth} />
                ) : (
                  <Lock size={ICON.size} strokeWidth={ICON.strokeWidth} />
                )}
              </IconBtn>
              {item.locked && (
                <p className="flex-1 self-center text-[11px] leading-relaxed text-amber-500/90">
                  잠김 — 이동·리사이즈·삭제·정렬이 차단됩니다. Ctrl+L 또는 버튼으로 해제.
                </p>
              )}
            </div>
          </Section>

          <Section
            title="문서 기준 정렬"
            icon={<AlignCenterVertical size={ICON.size} strokeWidth={ICON.strokeWidth} />}
          >
            <div className="grid grid-cols-3 gap-1.5">
              {DOC_ALIGN_BUTTONS.map(({ op, label }) => (
                <IconBtn
                  key={op}
                  label={label}
                  onClick={() => onDocAlign(op)}
                  disabled={item.locked === true}
                >
                  {op === 'docLeft' ? (
                    <AlignStartVertical size={ICON.size} strokeWidth={ICON.strokeWidth} />
                  ) : op === 'docCenterH' ? (
                    <AlignCenterVertical size={ICON.size} strokeWidth={ICON.strokeWidth} />
                  ) : op === 'docRight' ? (
                    <AlignEndVertical size={ICON.size} strokeWidth={ICON.strokeWidth} />
                  ) : op === 'docTop' ? (
                    <AlignStartHorizontal size={ICON.size} strokeWidth={ICON.strokeWidth} />
                  ) : op === 'docCenterV' ? (
                    <AlignCenterHorizontal size={ICON.size} strokeWidth={ICON.strokeWidth} />
                  ) : (
                    <AlignEndHorizontal size={ICON.size} strokeWidth={ICON.strokeWidth} />
                  )}
                </IconBtn>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              회전된 표시 영역 기준으로 문서 가장자리·중앙에 맞춥니다 (선택 1개만으로 동작).
            </p>
          </Section>

          <Section
            title="레이어 순서"
            icon={<Layers size={ICON.size} strokeWidth={ICON.strokeWidth} />}
          >
            <div className="grid grid-cols-4 gap-1.5">
              <IconBtn label="맨 앞으로" onClick={() => onOrder('front')}>
                <ArrowUpToLine size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
              <IconBtn label="앞으로" onClick={() => onOrder('forward')}>
                <ChevronUp size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
              <IconBtn label="뒤로" onClick={() => onOrder('backward')}>
                <ChevronDown size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
              <IconBtn label="맨 뒤로" onClick={() => onOrder('back')}>
                <ArrowDownToLine size={ICON.size} strokeWidth={ICON.strokeWidth} />
              </IconBtn>
            </div>
            {selectedIndex !== null && (
              <p className="mt-2 text-[11px] tabular-nums text-zinc-500">
                현재 레이어 <span className="text-zinc-300">{selectedIndex + 1}</span> / {itemCount}
              </p>
            )}
          </Section>

          <Section
            title="배경 제거"
            icon={<Eraser size={ICON.size} strokeWidth={ICON.strokeWidth} />}
          >
            {bgModePicker}
            <button
              type="button"
              onClick={onRemoveBg}
              disabled={removeBusy}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-indigo-500 bg-indigo-500/15 py-2 text-xs font-medium text-indigo-300 transition-colors hover:bg-indigo-500/25 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
            >
              {removeBusy ? (
                <Loader2 size={ICON.size} strokeWidth={ICON.strokeWidth} className="animate-spin" />
              ) : (
                <Eraser size={ICON.size} strokeWidth={ICON.strokeWidth} />
              )}
              {removeBusy ? removeBusyLabel : '배경 제거'}
            </button>
            {bgProgress}
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              {bgHelp} Ctrl+Z로 되돌릴 수 있습니다.
            </p>
            <button
              type="button"
              onClick={onOpenBgSites}
              title="결과가 마음에 들지 않을 때 쓸 수 있는 무료 배경 제거 사이트 모음"
              className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-[0.98]"
            >
              <Globe size={13} strokeWidth={1.5} className="text-zinc-400" />
              다른 배경 제거 사이트 보기
            </button>
          </Section>

          <Section
            title="업스케일"
            icon={<ZoomIn size={ICON.size} strokeWidth={ICON.strokeWidth} />}
          >
            <button
              type="button"
              onClick={onOpenUpscale}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-indigo-500 bg-indigo-500/15 py-2 text-xs font-medium text-indigo-300 transition-colors hover:bg-indigo-500/25 active:scale-95"
            >
              <ZoomIn size={ICON.size} strokeWidth={ICON.strokeWidth} />
              업스케일…
            </button>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              원본이 작아 인쇄 시 흐릿하다면 AI로 키우세요. 최종 크기를 cm로 정하면 필요한 해상도를
              자동으로 계산합니다. Ctrl+Z로 되돌릴 수 있습니다.
            </p>
          </Section>

          <Section
            title="이미지 복제"
            icon={<Grid3x3 size={ICON.size} strokeWidth={ICON.strokeWidth} />}
          >
            <button
              type="button"
              onClick={onOpenGrid}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-indigo-500 bg-indigo-500/15 py-2 text-xs font-medium text-indigo-300 transition-colors hover:bg-indigo-500/25 active:scale-95"
            >
              <Copy size={ICON.size} strokeWidth={ICON.strokeWidth} />
              이미지 복제…
            </button>
          </Section>
        </div>
      )}

      <div className="flex flex-col gap-1.5 border-t border-zinc-800 px-3 py-2.5">
        <div className="flex items-center justify-between text-[11px] tabular-nums text-zinc-500">
          <span>{item ? '선택 영역' : multi ? '다중 선택' : '문서'}</span>
          <span className="text-zinc-300">
            {item
              ? `${formatCm(item.widthPx)} × ${formatCm(item.heightPx)} cm`
              : multi
                ? `${multiSelectedCount}개 선택`
                : `배치 ${itemCount}개`}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void window.api?.openManualPdf()}
          title="번들된 사용자 메뉴얼 PDF를 기본 뷰어로 엽니다"
          className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-[0.98]"
        >
          <BookOpen size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
          <span className="flex-1 text-left">사용자 메뉴얼 (PDF)</span>
          <ExternalLink size={11} strokeWidth={1.5} className="shrink-0 text-zinc-600" />
        </button>
        <button
          type="button"
          onClick={() => void window.api?.openLicenses()}
          title="이 앱이 사용하는 오픈소스 라이브러리의 라이선스 고지를 엽니다"
          className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-[0.98]"
        >
          <Scale size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
          <span className="flex-1 text-left">오픈소스 라이선스</span>
          <ExternalLink size={11} strokeWidth={1.5} className="shrink-0 text-zinc-600" />
        </button>
      </div>
    </aside>
  )
}
