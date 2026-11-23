import { useLayoutEffect, useRef, useState } from 'react'
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
  ChevronDown,
  ChevronUp,
  Copy,
  Group,
  Lock,
  Trash2,
  Unlock,
  Ungroup
} from 'lucide-react'
import type { AlignOp, DocAlignOp } from './alignment'
import type { LayerOrderOp } from './placement'

interface ContextMenuProps {
  /** 뷰포트 로컬 화면 좌표 (우클릭 지점) */
  x: number
  y: number
  viewportW: number
  viewportH: number
  selectionCount: number
  canGroup: boolean
  canUngroup: boolean
  /** 정렬·분배 유닛 수 — 같은 그룹은 1유닛 (분배 가능 판정 기준) */
  alignUnitCount: number
  /** 선택에 잠금 해제 항목 포함 — true면 "잠금", 전부 잠겼으면 "잠금 해제" 표시 */
  anyUnlocked: boolean
  /** 바깥 클릭 판정용 루트 요소 ref — 부모(ProxyCanvas) window mousedown 캡처와 연동 */
  rootRef?: React.RefObject<HTMLDivElement | null>
  onDuplicate: () => void
  onDelete: () => void
  onToggleLock: () => void
  onGroup: () => void
  onUngroup: () => void
  onAlign: (op: AlignOp) => void
  onDocAlign: (op: DocAlignOp) => void
  onOrder: (op: LayerOrderOp) => void
}

const MENU_PAD = 8
const ICON = { size: 14, strokeWidth: 1.5 } as const

const ALIGN_GRID: ReadonlyArray<{ op: AlignOp; label: string; Icon: typeof Copy }> = [
  { op: 'left', label: '좌측 정렬', Icon: AlignStartVertical },
  { op: 'centerH', label: '가로 중앙 정렬', Icon: AlignCenterVertical },
  { op: 'right', label: '우측 정렬', Icon: AlignEndVertical },
  { op: 'top', label: '상단 정렬', Icon: AlignStartHorizontal },
  { op: 'centerV', label: '세로 중앙 정렬', Icon: AlignCenterHorizontal },
  { op: 'bottom', label: '하단 정렬', Icon: AlignEndHorizontal }
]

const DOC_ALIGN_GRID: ReadonlyArray<{ op: DocAlignOp; label: string; Icon: typeof Copy }> = [
  { op: 'docLeft', label: '문서 좌측에 정렬', Icon: AlignStartVertical },
  { op: 'docCenterH', label: '문서 가로 중앙에 정렬', Icon: AlignCenterVertical },
  { op: 'docRight', label: '문서 우측에 정렬', Icon: AlignEndVertical },
  { op: 'docTop', label: '문서 상단에 정렬', Icon: AlignStartHorizontal },
  { op: 'docCenterV', label: '문서 세로 중앙에 정렬', Icon: AlignCenterHorizontal },
  { op: 'docBottom', label: '문서 하단에 정렬', Icon: AlignEndHorizontal }
]

const ORDER_GRID: ReadonlyArray<{ op: LayerOrderOp; label: string; Icon: typeof Copy }> = [
  { op: 'front', label: '맨 앞으로', Icon: ArrowUpToLine },
  { op: 'forward', label: '앞으로', Icon: ChevronUp },
  { op: 'backward', label: '뒤로', Icon: ChevronDown },
  { op: 'back', label: '맨 뒤로', Icon: ArrowDownToLine }
]

function MenuItem({
  label,
  shortcut,
  icon,
  disabled = false,
  onClick
}: {
  label: string
  shortcut?: string
  icon?: React.ReactNode
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-40 ${
        disabled ? 'text-zinc-500' : 'text-zinc-200 hover:bg-zinc-800'
      }`}
    >
      {icon !== undefined && <span className="text-zinc-400">{icon}</span>}
      <span className="flex-1">{label}</span>
      {shortcut !== undefined && (
        <span className="text-[11px] tabular-nums text-zinc-500">{shortcut}</span>
      )}
    </button>
  )
}

const MenuSep = (): React.JSX.Element => <div className="my-1 h-px bg-zinc-800" />

/**
 * 캔버스 우클릭 컨텍스트 메뉴 — 복제·삭제·그룹·그룹 해제·정렬.
 * 열림/닫힘은 부모(ProxyCanvas)가 주관하며, 여기선 위치 클램프와 액션 버튼만 담당한다.
 */
export function ContextMenu({
  x,
  y,
  viewportW,
  viewportH,
  selectionCount,
  canGroup,
  canUngroup,
  alignUnitCount,
  anyUnlocked,
  rootRef,
  onDuplicate,
  onDelete,
  onToggleLock,
  onGroup,
  onUngroup,
  onAlign,
  onDocAlign,
  onOrder
}: ContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    const w = el?.offsetWidth ?? 200
    const h = el?.offsetHeight ?? 420
    setPos({
      x: Math.max(MENU_PAD, Math.min(x, viewportW - w - MENU_PAD)),
      y: Math.max(MENU_PAD, Math.min(y, viewportH - h - MENU_PAD))
    })
  }, [x, y, viewportW, viewportH])

  const hasSelection = selectionCount > 0
  const canAlign = selectionCount >= 2
  const canDistribute = alignUnitCount >= 3

  const setRoot = (node: HTMLDivElement): void => {
    ref.current = node
    if (rootRef) rootRef.current = node
  }

  return (
    <div
      ref={setRoot}
      className="absolute z-50 w-52 rounded-lg border border-zinc-800 bg-zinc-900/95 p-1 shadow-2xl backdrop-blur"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
    >
      <MenuItem
        label="복제"
        shortcut="Ctrl+D"
        icon={<Copy size={ICON.size} strokeWidth={ICON.strokeWidth} />}
        disabled={!hasSelection}
        onClick={onDuplicate}
      />
      <MenuItem
        label={anyUnlocked ? '잠금' : '잠금 해제'}
        shortcut="Ctrl+L"
        icon={
          anyUnlocked ? (
            <Lock size={ICON.size} strokeWidth={ICON.strokeWidth} />
          ) : (
            <Unlock size={ICON.size} strokeWidth={ICON.strokeWidth} />
          )
        }
        disabled={!hasSelection}
        onClick={onToggleLock}
      />
      <MenuItem
        label="삭제"
        shortcut="Del"
        icon={<Trash2 size={ICON.size} strokeWidth={ICON.strokeWidth} />}
        disabled={!hasSelection || !anyUnlocked}
        onClick={onDelete}
      />
      <MenuSep />
      <MenuItem
        label="그룹 만들기"
        shortcut="Ctrl+G"
        icon={<Group size={ICON.size} strokeWidth={ICON.strokeWidth} />}
        disabled={!canGroup}
        onClick={onGroup}
      />
      <MenuItem
        label="그룹 해제"
        shortcut="Ctrl+Shift+G"
        icon={<Ungroup size={ICON.size} strokeWidth={ICON.strokeWidth} />}
        disabled={!canUngroup}
        onClick={onUngroup}
      />
      <MenuSep />
      <div className="px-2.5 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        레이어 순서
      </div>
      <div className="grid grid-cols-4 gap-1 px-1.5">
        {ORDER_GRID.map(({ op, label, Icon }) => (
          <button
            key={op}
            type="button"
            disabled={!hasSelection}
            title={label}
            aria-label={label}
            onClick={() => onOrder(op)}
            className="flex h-7 items-center justify-center rounded-md text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
          >
            <Icon size={ICON.size} strokeWidth={ICON.strokeWidth} />
          </button>
        ))}
      </div>
      <MenuSep />
      <div className="px-2.5 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        정렬{canAlign ? ` (${selectionCount}개 선택 기준)` : ' (선택 2개 이상)'}
      </div>
      <div className="grid grid-cols-3 gap-1 px-1.5">
        {ALIGN_GRID.map(({ op, label, Icon }) => (
          <button
            key={op}
            type="button"
            disabled={!canAlign}
            title={label}
            aria-label={label}
            onClick={() => onAlign(op)}
            className="flex h-7 items-center justify-center rounded-md text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
          >
            <Icon size={ICON.size} strokeWidth={ICON.strokeWidth} />
          </button>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-2 gap-1 px-1.5 pb-1">
        <button
          type="button"
          disabled={!canDistribute}
          title="수평 간격 균등 분배 (그룹 포함 3유닛 이상)"
          aria-label="수평 간격 균등 분배 (그룹 포함 3유닛 이상)"
          onClick={() => onAlign('distH')}
          className="flex h-7 items-center justify-center gap-1 rounded-md text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
        >
          <AlignHorizontalJustifyCenter size={ICON.size} strokeWidth={ICON.strokeWidth} />
          수평 분배
        </button>
        <button
          type="button"
          disabled={!canDistribute}
          title="수직 간격 균등 분배 (그룹 포함 3유닛 이상)"
          aria-label="수직 간격 균등 분배 (그룹 포함 3유닛 이상)"
          onClick={() => onAlign('distV')}
          className="flex h-7 items-center justify-center gap-1 rounded-md text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
        >
          <AlignVerticalJustifyCenter size={ICON.size} strokeWidth={ICON.strokeWidth} />
          수직 분배
        </button>
      </div>
      <MenuSep />
      <div className="px-2.5 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        문서 기준 정렬{hasSelection ? '' : ' (선택 필요)'}
      </div>
      <div className="grid grid-cols-3 gap-1 px-1.5 pb-1">
        {DOC_ALIGN_GRID.map(({ op, label, Icon }) => (
          <button
            key={op}
            type="button"
            disabled={!hasSelection}
            title={label}
            aria-label={label}
            onClick={() => onDocAlign(op)}
            className="flex h-7 items-center justify-center rounded-md text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
          >
            <Icon size={ICON.size} strokeWidth={ICON.strokeWidth} />
          </button>
        ))}
      </div>
    </div>
  )
}
