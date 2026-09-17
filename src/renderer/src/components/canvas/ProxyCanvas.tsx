import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Konva from 'konva'
import type { Box } from 'konva/lib/shapes/Transformer'
import { Image, Layer, Line, Rect, Shape, Stage, Text, Transformer } from 'react-konva'
import {
  Boxes,
  Expand,
  FileOutput,
  FilePlus2,
  FolderOpen,
  Grid2x2,
  Grid3x3,
  ImagePlus,
  LayoutGrid,
  Maximize,
  Minus,
  Plus,
  Redo2,
  Save,
  Scissors,
  Shrink,
  Undo2
} from 'lucide-react'
import { ContextMenu } from './ContextMenu'
import { ExportDialog } from './ExportDialog'
import { GridDialog } from './GridDialog'
import { GridSettingsDialog } from './GridSettingsDialog'
import { NestingDialog } from './NestingDialog'
import { RulerOverlay } from './RulerOverlay'
import { BgSitesDialog } from '../BgSitesDialog'
import { UpscaleDialog } from '../UpscaleDialog'
import { packImages } from './autoNesting'
import {
  alignItems,
  alignToDocument,
  marqueeSelection,
  rotatedBBox,
  type AlignOp,
  type DocAlignOp
} from './alignment'
import {
  computeSnap,
  unionOfItems,
  type SnapGapLabel,
  type SnapGuide,
  type SnapTarget
} from './snap'
import {
  cloneWithNewGroups,
  expandSelectionToGroups,
  groupSelection,
  isSingleCompleteGroup,
  ungroupSelection
} from './grouping'
import {
  DEFAULT_GRID_SETTINGS,
  gridDash,
  gridLinePositions,
  type GridSettings
} from './gridOverlay'
import {
  calculateGridPositions,
  centeredTopLeft,
  commitTransform,
  constrainAxis,
  duplicateOffset,
  fitToCanvas,
  normalizeRotation,
  reorderItems,
  screenToDoc,
  viewCenterDoc,
  type DocPoint,
  type FitMode,
  type LayerOrderOp,
  type NodeTransformReading,
  type ViewTransform
} from './placement'
import { useHtmlImage } from './useHtmlImage'
import { PropertiesPanel } from '../PropertiesPanel'
import { mmToPx, pxToMm } from '../../../../core/math'
import { physicalDocPixels } from '../../../../core/imageMeta'
import type { ImportedImage, UpscaledImage } from '../../../../types/ipc'
import { PROJECT_FORMAT, PROJECT_VERSION, type ProjectData } from '../../../../core/project'

/**
 * 프록시 캔버스 뷰포트 (S3) + 씬 이미지 배치·선택·이동·삭제 (S4)·리사이즈/회전/복제/그리드 (S5).
 *
 * - Stage 크기 = 브라우저 창(뷰포트) 고정 — 실제 6,890×N px 메모리의 Stage를 만들지 않는다.
 * - 문서는 가상 좌표계(350 DPI 절대 px)의 흰색 Rect + 이미지 노드로 표현 (CLAUDE.md §1:
 *   내부 데이터는 항상 절대 픽셀, 스케일은 뷰 변환에서만 처리).
 * - 줌/팬은 stage.scale()/stage.position() 내장 속성만 조작 (객체 좌표 직접 연산 금지).
 * - 이미지 노드는 원본 px 크기 그대로 렌더 — ≤2,048px 프리뷰 dataURL은 화면 표시 소스일 뿐.
 */

/** 씬에 배치된 이미지 — 좌표·크기는 전부 350 DPI 절대 px (음수 = 캔버스 밖 허용) */
export interface PlacedImage {
  id: string
  /** 원본 파일 절대 경로 — S6 내보내기(풀해상도 렌더)에서 사용 */
  filePath: string
  /** ≤2,048px PNG 프리뷰 dataURL — 표시 전용 */
  dataUrl: string
  widthPx: number
  heightPx: number
  x: number
  y: number
  /** 노드 중심 회전각 (도, -180 < r ≤ 180) — Konva rotation과 동일 단위 */
  rotation: number
  /** 선택적 그룹 식별자 — 같은 groupId를 공유하는 항목이 하나의 그룹으로 선택·이동된다 */
  groupId?: string
  /** 잠금 — 드래그·트랜스폼·삭제·정렬 등 편집 보호. 선택은 가능(잠금 해제용). */
  locked?: boolean
}

/** 줌 클램프 (화면 배율 기준) */
const MIN_SCALE = 0.02
const MAX_SCALE = 8

// Konva 기본 dragButtons=[0,1]은 중앙 버튼(휠 클릭)도 노드 드래그로 시작시킨다 —
// 이 앱에서 휠 클릭은 팬 전용이므로 좌클릭만 노드 드래그로 제한한다
// (이미지 위에서 휠 클릭 팬 시 이미지가 끌리던 결함, 2026-09-04 접수).
Konva.dragButtons = [0]
/** 휠 delta → 줌 비율 (exp 곱산: 휠·트랙패드 공통 부드러움) */
const ZOOM_SENSITIVITY = 0.0015
/** fit-to-screen 시 화면 가장자리 여백 (px) */
const FIT_PADDING = 24
/** 문서 배경 Rect 식별명 — 빈 곳 클릭(선택 해제) 판정에 사용 */
const DOC_BACKGROUND = 'doc-background'
const SELECTION_STROKE = '#6366f1'
/** 잠금 항목 선택 테두리 — 확정 블록 보호 표시 */
const LOCKED_STROKE = '#f59e0b'
/** 드래그 스냅 가이드 라인·간격 라벨 */
const SNAP_GUIDE_STROKE = '#22d3ee'
/** 스냅 임계값 (화면 px — 문서 px은 줌 배율로 환산) */
const SNAP_THRESHOLD_SCREEN_PX = 6
/** Shift 회전 스냅 — 15° 배수, 허용 오차 내 접근 시 스냅 */
const ROTATION_SNAP_STEP_DEG = 15
const ROTATION_SNAPS = Array.from(
  { length: 360 / ROTATION_SNAP_STEP_DEG },
  (_, i) => i * ROTATION_SNAP_STEP_DEG
)
/** 리사이즈 최소 치수 (절대 px) — 반전·음수 치수 방지 (표준 Konva 레시피) */
const MIN_TRANSFORM_PX = 5
/** undo 히스토리 상한 (단계) — 초과분은 가장 오래된 스냅샷부터 폐기 */
const UNDO_LIMIT = 100
/** 마키 시작을 클릭으로 판정하는 화면 px 임계 — 미만 이동은 선택 해제로만 처리 */
const MARQUEE_CLICK_PX = 3
/** 방향키 이동 기본 거리 (mm) — 1mm 단위로 1~50mm 조절 */
const NUDGE_DEFAULT_MM = 5
const NUDGE_MIN_MM = 1
const NUDGE_MAX_MM = 50
/** Shift+방향키 미세 이동 거리 (mm) */
const NUDGE_FINE_MM = 1
/** 연속 방향키 누름을 하나의 undo 단계로 묶는 공백 허용 시간 (ms) */
const NUDGE_COALESCE_MS = 900

const boundMinSize = (oldBox: Box, newBox: Box): Box =>
  newBox.width < MIN_TRANSFORM_PX || newBox.height < MIN_TRANSFORM_PX ? oldBox : newBox

/** 스냅 계산용 배치 조각 — PlacedImage에서 기하만 남긴다 (드래그 세션에 적재) */
const toSnapItem = (
  img: PlacedImage
): {
  id: string
  x: number
  y: number
  widthPx: number
  heightPx: number
  rotation: number
} => ({
  id: img.id,
  x: img.x,
  y: img.y,
  widthPx: img.widthPx,
  heightPx: img.heightPx,
  rotation: img.rotation
})

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

/** 캔버스 전역 키보드 단축키를 텍스트 입력(그리드 대화상자 등)에서는 무시 */
const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable)

/** 문서 전체가 화면에 들어오는 뷰 변환(fit-to-screen) 계산 */
function fitView(docW: number, docH: number, viewW: number, viewH: number): ViewTransform {
  const scale = Math.min((viewW - FIT_PADDING * 2) / docW, (viewH - FIT_PADDING * 2) / docH)
  return { scale, x: (viewW - docW * scale) / 2, y: (viewH - docH * scale) / 2 }
}

/** 배경 제거 치환 항목 — 트림되면 치수가 변해 배치 축 재환산이 필요하다 */
interface RemovedBgEntry {
  id: string
  filePath: string
  dataUrl: string
  srcWidthPx: number
  srcHeightPx: number
  /** null이면 치수 불변(트림 no-op·OFF·실패 폴백) */
  trimmed: { widthPx: number; heightPx: number } | null
}

/** 치환 시 배치 축(원본 px→문서 px) 비율은 유지하고 기존 항목의 중심점을 보존한다 */
const applyRemovedBg = (img: PlacedImage, entry: RemovedBgEntry): PlacedImage => {
  if (entry.trimmed === null) {
    return { ...img, filePath: entry.filePath, dataUrl: entry.dataUrl }
  }
  const newW = (entry.trimmed.widthPx / entry.srcWidthPx) * img.widthPx
  const newH = (entry.trimmed.heightPx / entry.srcHeightPx) * img.heightPx
  return {
    ...img,
    filePath: entry.filePath,
    dataUrl: entry.dataUrl,
    widthPx: newW,
    heightPx: newH,
    x: img.x + (img.widthPx - newW) / 2,
    y: img.y + (img.heightPx - newH) / 2
  }
}

export interface ProxyCanvasProps {
  /** 문서 가로 (350 DPI px) — 6,890 */
  widthPx: number
  /** 문서 세로 (350 DPI px) — 13,780 / 27,559 */
  heightPx: number
  /** 세션 시작 씬 — 새 문서(빈 배열) 또는 불러온 프로젝트 이미지 */
  initialImages: PlacedImage[]
  /** 프로젝트 로드 횟수(nonce) — 증가 시 씬을 initialImages로 전체 교체 */
  loadNonce: number
  /** 툴바 "열기" — App이 .dtf 다이얼로그를 주관한다(문서 규격 교체 필요) */
  onOpenProject: () => void
  /** 툴바 "새 파일" — App이 세션을 폐기하고 새 문서 설정 화면으로 돌아간다 */
  onNewProject: () => void
  /** 열린 프로젝트 파일 이름 (확장자 제외) — 새 문서는 null */
  projectFileName: string | null
  /** 저장 완료로 문서 이름이 확정될 때 App 세션에 반영 */
  onProjectFileName: (name: string) => void
}

export function ProxyCanvas({
  widthPx,
  heightPx,
  initialImages,
  loadNonce,
  onOpenProject,
  onNewProject,
  projectFileName,
  onProjectFileName
}: ProxyCanvasProps): React.JSX.Element {
  const stageRef = useRef<Konva.Stage>(null)
  /** 씬 전체에서 유일한 트랜스포머 — 선택 테두리 렌더 (이미지별 트랜스포머 금지) */
  const transformerRef = useRef<Konva.Transformer>(null)
  /** 속성 패널을 제외한 캔버스 뷰포트 영역 — Stage 크기·드롭 좌표의 기준 */
  const viewportRef = useRef<HTMLDivElement>(null)
  /** 사용자가 줌/팬을 한 번이라도 조작했는가 — 조작 전엔 리사이즈 시 자동 refit */
  const interactedRef = useRef(false)

  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const [spaceDown, setSpaceDown] = useState(false)
  const [view, setView] = useState<ViewTransform>(() =>
    fitView(widthPx, heightPx, window.innerWidth, window.innerHeight)
  )
  const [images, setImages] = useState<PlacedImage[]>(initialImages)
  /**
   * 실행취소 히스토리 — PlacedImage[] JSON 스냅샷만 저장 (Konva 객체 저장 금지 철칙).
   * 스냅샷은 배열 참조를 그대로 두는데, 씬 갱신은 항상 spread/map으로 새 배열을 만들므로
   * 참조가 불변이라는 규칙이 성립한다 (dataUrl 문자열 중복 복사 방지).
   */
  const [history, setHistory] = useState<{ past: PlacedImage[][]; future: PlacedImage[][] }>({
    past: [],
    future: []
  })
  /** 다중 선택 (.agent/tech.md §3) — 배열 순서 = 선택 순서, 씬 배열 순과 무관 */
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  /** 드래그 영역 선택(마키) 진행 상태 — null이면 비활성. 좌표는 문서(절대 px) */
  const [marquee, setMarquee] = useState<{
    start: DocPoint
    current: DocPoint
    /** Ctrl 드래그 시작 시점의 기존 선택 — 마키 히트를 합산한다 */
    baseIds: string[]
    additive: boolean
  } | null>(null)
  const [gridOpen, setGridOpen] = useState(false)
  const [gridSettingsOpen, setGridSettingsOpen] = useState(false)
  const [bgSitesOpen, setBgSitesOpen] = useState(false)
  /** 업스케일 대화상자 — 열림 시점의 항목 id·원본 경로를 캡처해 치환 정합성 유지 */
  const [upscaleTarget, setUpscaleTarget] = useState<{ id: string; filePath: string } | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [nestingOpen, setNestingOpen] = useState(false)
  /** 방향키 이동 거리 (mm) — 1mm 단위 조절, 기본 5mm */
  const [nudgeStepMm, setNudgeStepMm] = useState(NUDGE_DEFAULT_MM)
  /** 우클릭 컨텍스트 메뉴 위치 (뷰포트 로컬 화면 px) — null이면 닫힘 */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  /** 그리드 표시 설정 — 보기 옵션이라 히스토리(undo) 대상 아님 */
  const [gridSettings, setGridSettings] = useState<GridSettings>(DEFAULT_GRID_SETTINGS)
  /** 문서 배경 체커보드 표시 — 흰색 배경 이미지의 경계 식별용 보기 옵션(표시 전용) */
  const [checkerBg, setCheckerBg] = useState(false)
  /**
   * 투명 여백 자동 제거(Auto-Trim) — 이미지 가져오기 시 알파 바운딩 박스로 크롭해
   * 배치·정렬 간격이 피사체 기준이 되게 한다. 기본 ON, 선택값은 localStorage 저장.
   */
  const [autoTrim, setAutoTrim] = useState<boolean>(() => {
    try {
      return localStorage.getItem('dtf:auto-trim') !== 'off'
    } catch {
      return true
    }
  })
  const toggleAutoTrim = useCallback((): void => {
    setAutoTrim((prev) => {
      try {
        localStorage.setItem('dtf:auto-trim', prev ? 'off' : 'on')
      } catch {
        /* 저장 실패는 세션 내 상태로만 동작 */
      }
      return !prev
    })
  }, [])
  /** 휠 클릭(중앙 버튼) 드래그 팬 진행 중 — 커서 표시용 */
  const [panning, setPanning] = useState(false)
  /** 배경 제거 진행 중 — 사이드카 추론 동안 버튼 잠금 */
  const [removeBusy, setRemoveBusy] = useState(false)
  /** 배경 제거 배치 진행률 — 완료 즉시 캔버스에 반영되므로 n/N로 표기 */
  const [removeProgress, setRemoveProgress] = useState<{ current: number; total: number } | null>(
    null
  )
  /** 드래그 스냅 오버레이 — 가이드 라인·간격 라벨 (드래그 중에만 존재) */
  const [snapOverlay, setSnapOverlay] = useState<{
    guides: SnapGuide[]
    labels: SnapGapLabel[]
  } | null>(null)
  /** Shift 홀드 — 회전 핸들 15° 스냅 활성화 (드래그 축 고정과 독립) */
  const [shiftDown, setShiftDown] = useState(false)
  /** 앱 내부 클립보드 — Ctrl+C/X로 적재, Ctrl+V로 캐스케이드 오프셋 반복 붙여넣기 */
  const clipboardRef = useRef<PlacedImage[]>([])
  const pasteCountRef = useRef(0)

  /** 체커보드 패턴 타일(16px) — 흰색 배경 이미지의 경계 식별용 */
  const checkerPattern = useMemo(() => {
    const tile = document.createElement('canvas')
    tile.width = 16
    tile.height = 16
    const ctx = tile.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 16, 16)
    ctx.fillStyle = '#d4d4d8'
    ctx.fillRect(0, 0, 8, 8)
    ctx.fillRect(8, 8, 8, 8)
    return tile
  }, [])

  /**
   * 단일 선택 항목 — 정확히 1개 선택 시에만 존재(수치 편집·그리드 복제·화면 채우기 기준).
   * 다중 선택에서는 null — 편집은 정렬 패널로 대체된다.
   */
  const selectedItem =
    selectedIds.length === 1 ? (images.find((img) => img.id === selectedIds[0]) ?? null) : null

  const { past, future } = history

  /**
   * 연속 커밋 병합 추적 — 방향키 홀드 폭주가 undo 100단계를 덮어쓰지 않게 한다.
   * 같은 coalesceKey를 900ms 안에 다시 쓰면 past 푸시를 생략한다(첫 커밋 스냅샷 유지).
   */
  const lastCoalesceRef = useRef<{ key: string; at: number } | null>(null)

  /**
   * 노드 드래그 세션 — mousedown 시점 modifier로 모드가 결정된다.
   * move: 선택 항목 전체 이동(그룹 포함). duplicate: Ctrl+드래그 — 사본을 먼저
   * 씬에 추가(히스토리 없이)하고 원본 노드는 제자리에 고정한 채 사본만 움직인다.
   */
  interface DragSession {
    mode: 'move' | 'duplicate'
    draggedId: string
    /** 이동 대상 시작 위치 — move=선택 항목들, duplicate=드래그 원본+사본들 */
    base: Map<string, { x: number; y: number }>
    /** undo 기준 스냅샷 — duplicate에서는 복제 이전 씬 */
    preScene: PlacedImage[]
    /** duplicate 시작 시점 선택 복원용 */
    selectionBefore: string[]
    /** dragmove가 확정한 최종 델타 — duplicate는 원본 노드를 제자리로 되돌리므로
     *  dragend의 node 위치를 믿을 수 없어 세션에 추적한다 */
    lastDelta: { dx: number; dy: number }
    /** 드래그 스냅 문맥 — 이동군 시작 배치·정적 스냅 대상·문서 좌표 임계값 */
    snap: {
      movingItems: Array<{
        id: string
        x: number
        y: number
        widthPx: number
        heightPx: number
        rotation: number
      }>
      targets: SnapTarget[]
      threshold: number
    } | null
  }
  const dragRef = useRef<DragSession | null>(null)
  /** Ctrl+클릭 토글 해제 지연 — 드래그로 복제가 되면 취소, mouseup(무이동) 시 확정 */
  const pendingToggleOffRef = useRef<string | null>(null)
  /** mousedown modifier 스냅샷 — dragstart 시점엔 네이티브 evt가 없어 미리 캡처 */
  const gestureRef = useRef<{ id: string; ctrl: boolean } | null>(null)

  /**
   * 히스토리 기록 씬 변경 커밋 — 모든 이미지 변경 경로의 단일 관문. 변경 전 스냅샷을
   * past에 push(상한 100)하고 future를 폐기해 새 변경 이후의 redo를 무효화한다.
   * 업데이터는 순수 함수만 받는다(StrictMode 이중 호출 안전 — randomUUID는 밖에서).
   * base는 past에 남길 기준 씬(기본=현재 씬) — Ctrl+드래그 복제처럼 히스토리 없이
   * 씬이 먼저 바뀐 경로는 복제 이전 스냅샷을 명시한다.
   */
  const commitImages = useCallback(
    (
      updater: (prev: PlacedImage[]) => PlacedImage[],
      base?: PlacedImage[],
      coalesceKey?: string
    ): void => {
      const now = Date.now()
      const last = lastCoalesceRef.current
      const coalesce =
        coalesceKey !== undefined &&
        last !== null &&
        last.key === coalesceKey &&
        now - last.at < NUDGE_COALESCE_MS
      lastCoalesceRef.current = coalesceKey !== undefined ? { key: coalesceKey, at: now } : null
      setHistory((h) =>
        coalesce
          ? { past: h.past, future: [] }
          : { past: [...h.past, base ?? images].slice(-UNDO_LIMIT), future: [] }
      )
      setImages(updater)
    },
    [images]
  )

  /** 실행취소 — past 마지막 스냅샷으로 복원, 현재 상태는 future로 이동.
   *  복원 씬에 선택 항목이 없으면 선택 해제(트랜스포머 유령 방지) — id를 제거하는 경로는
   *  삭제(명시적 해제)·undo/redo뿐이므로 여기서 가드하면 충분하다. */
  const undo = useCallback((): void => {
    if (past.length === 0) return
    const prev = past[past.length - 1]
    setHistory((h) => ({
      past: h.past.slice(0, -1),
      future: [images, ...h.future].slice(0, UNDO_LIMIT)
    }))
    setImages(prev)
    setSelectedIds((sel) =>
      sel.length > 0 ? sel.filter((id) => prev.some((img) => img.id === id)) : sel
    )
  }, [past, images])

  /** 다시실행 — future 선두 스냅샷 재적용, 현재 상태는 past로 이동 (선택 가드는 undo와 동일) */
  const redo = useCallback((): void => {
    if (future.length === 0) return
    const next = future[0]
    setHistory((h) => ({
      past: [...h.past, images].slice(0, UNDO_LIMIT),
      future: h.future.slice(1)
    }))
    setImages(next)
    setSelectedIds((sel) =>
      sel.length > 0 ? sel.filter((id) => next.some((img) => img.id === id)) : sel
    )
  }, [future, images])

  const canUndo = past.length > 0
  const canRedo = future.length > 0

  /**
   * 프로젝트 로드 채택 — nonce 증가 시 씬을 initialImages로 전체 교체하고 히스토리·
   * 선택을 초기화한다(undo는 로드 이후 편집부터). 마운트 nonce는 useState 초기값으로
   * 이미 반영됐으므로 건너뛴다.
   */
  const adoptedNonceRef = useRef(loadNonce)
  useEffect(() => {
    if (loadNonce === adoptedNonceRef.current) return
    adoptedNonceRef.current = loadNonce
    setImages(initialImages)
    setHistory({ past: [], future: [] })
    setSelectedIds([])
  }, [loadNonce, initialImages])

  // 씬 변경 통보 — Electron에서는 수신자가 없어 무효(inert). 웹 빌드의 자동저장·E2E 검증이 소비한다.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('dtf:scene-committed', {
        detail: { widthPx, heightPx, images }
      })
    )
  }, [images, widthPx, heightPx])

  /** 뷰포트(패널 제외 캔버스 영역) 크기 추적 — 조작 이력 없으면 문서를 다시 맞춤 */
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      setSize({ w, h })
      if (!interactedRef.current) setView(fitView(widthPx, heightPx, w, h))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [widthPx, heightPx])

  /** 스페이스 홀드 = 팬 모드 (커서 grab + Stage 드래그 활성) — 텍스트 입력·모달 중 무시 */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (
        gridOpen ||
        gridSettingsOpen ||
        bgSitesOpen ||
        exportOpen ||
        nestingOpen ||
        upscaleTarget !== null ||
        isEditableTarget(e.target)
      )
        return
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault()
        setSpaceDown(true)
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') setSpaceDown(false)
    }
    const onBlur = (): void => setSpaceDown(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [gridOpen, gridSettingsOpen, bgSitesOpen, exportOpen, nestingOpen, upscaleTarget])

  /**
   * .dtf 프로젝트 저장 — 씬을 dataUrl 없는 스키마로 직렬화해 메인에 위임
   * (다이얼로그·기록·자체 검증은 메인 담당). pathOverride는 E2E 주입용.
   */
  const handleSave = useCallback(
    async (pathOverride?: string): Promise<void> => {
      const data: ProjectData = {
        format: PROJECT_FORMAT,
        version: PROJECT_VERSION,
        document: { widthPx, heightPx },
        images: images.map(
          ({ id, filePath, widthPx: w, heightPx: h, x, y, rotation, groupId, locked }) => ({
            id,
            filePath,
            widthPx: w,
            heightPx: h,
            x,
            y,
            rotation,
            groupId,
            ...(locked ? { locked: true } : {})
          })
        )
      }
      try {
        const savedPath = await window.api.saveProject(data, pathOverride)
        if (savedPath) {
          const name = savedPath
            .split(/[\\/]/)
            .pop()
            ?.replace(/\.[^.]+$/, '')
          if (name) onProjectFileName(name)
        }
      } catch (err) {
        alert(`프로젝트 저장 실패: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [images, widthPx, heightPx, onProjectFileName]
  )

  /** E2E 자동검증 훅 (dtf:import-paths 패턴 계승) — 저장 다이얼로그 없이 경로로 기록 */
  useEffect(() => {
    const onSaveProject = (e: Event): void => {
      const path = (e as CustomEvent<string>).detail
      if (typeof path === 'string' && path.length > 0) void handleSave(path)
    }
    window.addEventListener('dtf:save-project', onSaveProject)
    return () => window.removeEventListener('dtf:save-project', onSaveProject)
  }, [handleSave])

  /** 잠금 해제 사본 생성 규칙 — 복제·붙여넣기 결과물은 편집 가능한 상태로 시작한다 */
  const stripLock = (img: PlacedImage): PlacedImage => ({ ...img, locked: undefined })

  /** 스냅 정적 대상 — 이동군 제외 나머지 씬 + 문서 박스(가장자리·중앙선). 잠금 항목도 포함 */
  const buildSnapTargets = useCallback(
    (excludeIds: ReadonlySet<string>): SnapTarget[] => [
      ...images
        .filter((img) => !excludeIds.has(img.id))
        .map((img) => ({ box: rotatedBBox(img), kind: 'item' as const })),
      { box: { left: 0, top: 0, right: widthPx, bottom: heightPx }, kind: 'doc' as const }
    ],
    [images, widthPx, heightPx]
  )

  /** 선택 항목 전체 삭제 — 컨텍스트 메뉴·Del 공용. 잠긴 항목은 남기고 나머지만 삭제 */
  const handleDeleteSelection = useCallback((): void => {
    if (selectedIds.length === 0) return
    const lockedIds = new Set(
      images.filter((img) => selectedIds.includes(img.id) && img.locked).map((img) => img.id)
    )
    const deleting = selectedIds.filter((id) => !lockedIds.has(id))
    if (deleting.length === 0) return
    commitImages((prev) => prev.filter((img) => !deleting.includes(img.id)))
    setSelectedIds((sel) => (lockedIds.size > 0 ? sel.filter((id) => !deleting.includes(id)) : []))
  }, [selectedIds, images, commitImages])

  /** 블록 복제 — 선택 전체를 화면 24px 오프셋으로 복사(그룹은 새 그룹 id로 재매핑), 사본 선택 */
  const handleDuplicate = useCallback((): void => {
    const selected = images.filter((img) => selectedIds.includes(img.id))
    if (selected.length === 0) return
    const offset = duplicateOffset(view.scale)
    const copies = cloneWithNewGroups(selected, { dx: offset, dy: offset }, () =>
      crypto.randomUUID()
    ).map(stripLock)
    commitImages((prev) => [...prev, ...copies])
    setSelectedIds(copies.map((copy) => copy.id))
  }, [images, selectedIds, view.scale, commitImages])

  /** 내부 클립보드 복사 — 선택 전체(그룹 관계 포함)를 통째로 적재, 붙여넣기 카운트 초기화 */
  const handleCopy = useCallback((): void => {
    const selected = images.filter((img) => selectedIds.includes(img.id))
    if (selected.length === 0) return
    clipboardRef.current = selected
    pasteCountRef.current = 0
  }, [images, selectedIds])

  /** 잘라내기 — 복사 후 삭제(잠금 항목은 남음) */
  const handleCut = useCallback((): void => {
    handleCopy()
    handleDeleteSelection()
  }, [handleCopy, handleDeleteSelection])

  /** 붙여넣기 — 클립보드를 화면 24px 캐스케이드 오프셋(횟수 배수)으로 복제·선택 */
  const handlePaste = useCallback((): void => {
    const source = clipboardRef.current
    if (source.length === 0) return
    pasteCountRef.current += 1
    const offset = duplicateOffset(view.scale) * pasteCountRef.current
    const copies = cloneWithNewGroups(source, { dx: offset, dy: offset }, () =>
      crypto.randomUUID()
    ).map(stripLock)
    commitImages((prev) => [...prev, ...copies])
    setSelectedIds(copies.map((copy) => copy.id))
  }, [view.scale, commitImages])

  /** 잠금 토글 — 하나라도 잠금 해제 항목이 있으면 전체 잠금, 전부 잠겨 있으면 해제 */
  const handleToggleLock = useCallback((): void => {
    const selected = images.filter((img) => selectedIds.includes(img.id))
    if (selected.length === 0) return
    const lockTo = !selected.every((img) => img.locked === true)
    commitImages((prev) =>
      prev.map((img) => (selectedIds.includes(img.id) ? { ...img, locked: lockTo } : img))
    )
  }, [images, selectedIds, commitImages])

  /** 선택 항목(2개 이상)을 하나의 그룹으로 — 이미 동일 단일 그룹이면 no-op. 잠긴 항목은 그룹화 불가 */
  const handleGroup = useCallback((): void => {
    if (selectedIds.length < 2) return
    if (isSingleCompleteGroup(images, selectedIds)) return
    if (images.some((img) => selectedIds.includes(img.id) && img.locked)) return
    const groupId = crypto.randomUUID()
    commitImages((prev) => groupSelection(prev, selectedIds, groupId))
  }, [images, selectedIds, commitImages])

  /** 선택이 닿는 그룹 전체 해제 (미선택 멤버 포함) — 선택은 유지. 잠긴 항목 포함 시 불가 */
  const handleUngroup = useCallback((): void => {
    if (images.some((img) => selectedIds.includes(img.id) && img.locked)) return
    commitImages((prev) => ungroupSelection(prev, selectedIds))
  }, [images, selectedIds, commitImages])

  /** 방향키 누적 이동 — 연속 누름은 900ms 창에서 한 undo 단계로 병합. 잠긴 항목은 제외 */
  const handleNudge = useCallback(
    (dirX: number, dirY: number, fine: boolean): void => {
      const stepPx = mmToPx(fine ? NUDGE_FINE_MM : nudgeStepMm)
      if (stepPx <= 0) return
      const movable = new Set(
        images.filter((img) => selectedIds.includes(img.id) && !img.locked).map((img) => img.id)
      )
      if (movable.size === 0) return
      commitImages(
        (prev) =>
          prev.map((img) =>
            movable.has(img.id)
              ? { ...img, x: img.x + dirX * stepPx, y: img.y + dirY * stepPx }
              : img
          ),
        undefined,
        'nudge'
      )
    },
    [selectedIds, images, nudgeStepMm, commitImages]
  )

  /**
   * 씬 편집 단축키 (통합) — Ctrl+Z=실행취소, Ctrl+Shift+Z/Ctrl+Y=다시실행(선택 불필요),
   * Del/Backspace=삭제, R=90° 회전, Ctrl/Cmd+D=복제(화면 24px 오프셋 — 캐스케이드 규칙),
   * Ctrl+C/X/V=내부 클립보드 복사·잘라내기·붙여넣기, Ctrl+L=잠금 토글,
   * Ctrl+G/Ctrl+Shift+G=그룹·그룹 해제, 방향키=이동(Shift=1mm 미세).
   * 대화상자 모달 중·텍스트 입력 포커스 중·드래그 진행 중에는 전면 무시한다.
   */
  useEffect(() => {
    if (
      gridOpen ||
      gridSettingsOpen ||
      bgSitesOpen ||
      exportOpen ||
      nestingOpen ||
      upscaleTarget !== null
    )
      return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isEditableTarget(e.target)) return
      if (dragRef.current !== null) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault() // 브라우저/Electron 기본 페이지 저장 차단
        if (!e.repeat) void handleSave()
        return
      }
      if (mod && 'zyZY'.includes(e.key)) {
        e.preventDefault() // 브라우저/Electron 기본 undo·redo 차단
        if (e.repeat) return // 키 홀드 폭주 방지 — 단위 스텝만
        const isRedo = e.key === 'y' || e.key === 'Y' || e.shiftKey
        if (isRedo) redo()
        else undo()
        return
      }
      if (mod && 'cvxCVX'.includes(e.key)) {
        e.preventDefault() // 내부 클립보드가 시스템 클립보드 동작을 대체
        if (e.repeat) return
        const key = e.key.toLowerCase()
        if (key === 'c') handleCopy()
        else if (key === 'v') handlePaste()
        else handleCut()
        return
      }
      if (mod && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault()
        if (!e.repeat) handleToggleLock()
        return
      }
      if (mod && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault()
        if (e.repeat) return
        if (e.shiftKey) handleUngroup()
        else handleGroup()
        return
      }
      if (selectedIds.length === 0) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        handleDeleteSelection()
        return
      }
      if ((e.key === 'r' || e.key === 'R') && !e.repeat) {
        e.preventDefault()
        commitImages((prev) =>
          prev.map((img) =>
            selectedIds.includes(img.id) && !img.locked
              ? { ...img, rotation: normalizeRotation(img.rotation + 90) }
              : img
          )
        )
        return
      }
      if (mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault() // 브라우저 기본 동작(북마크) 차단 — Electron에서도 명시 차단
        if (e.repeat) return
        handleDuplicate()
        return
      }
      const nudgeDirs: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1]
      }
      const dir = nudgeDirs[e.key]
      if (dir) {
        e.preventDefault() // 스크롤·가상커서 이동 등 기본 동작 차단
        handleNudge(dir[0], dir[1], e.shiftKey)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    selectedIds,
    gridOpen,
    gridSettingsOpen,
    bgSitesOpen,
    exportOpen,
    nestingOpen,
    upscaleTarget,
    commitImages,
    undo,
    redo,
    handleSave,
    handleDuplicate,
    handleCopy,
    handleCut,
    handlePaste,
    handleToggleLock,
    handleGroup,
    handleUngroup,
    handleNudge,
    handleDeleteSelection
  ])

  /**
   * 단일 공유 트랜스포머에 선택 노드들 바인딩 — 1개면 리사이즈·회전 핸들, 2개 이상이면
   * 합집합 보더만(resizeEnabled/rotateEnabled=false) 렌더한다. 다중 이동은 노드
   * 드래그 동기화(handleNodeDragMove)가 담당한다.
   */
  useEffect(() => {
    const transformer = transformerRef.current
    const stage = stageRef.current
    if (!transformer || !stage) return
    const nodes = selectedIds
      // 잠긴 항목은 선택 테두리(노드 스트로크)만 — 리사이즈·회전 핸들을 붙이지 않는다
      .filter((id) => images.find((img) => img.id === id)?.locked !== true)
      .map((id) => stage.findOne(`#${id}`))
      .filter((node): node is Konva.Node => node !== undefined)
    transformer.nodes(nodes)
    // Konva Transformer의 _proxyDrag 프록시(노드별 dragstart/dragmove 리스너 — 네임스페이스
    // tr-konva{_id})는 한 노드의 드래그를 나머지 선택 노드에 강제 전파(startDrag)해 진행 중
    // 드래그 세션을 오염시킨다(Ctrl+드래그 복제가 move로 뒤집히는 2026-09-03 실기 재현 결함).
    // 다중 선택 이동 동기화는 handleNodeDragMove가 전담하므로 프록시는 제거한다.
    const proxyNamespace = `tr-konva${transformer._id}`
    for (const node of transformer.getNodes()) {
      node.off(`dragstart.${proxyNamespace}`)
      node.off(`dragmove.${proxyNamespace}`)
    }
    transformer.getLayer()?.batchDraw()
  }, [selectedIds, images])

  /** Shift 홀드 추적 — 회전 핸들 15° 스냅 활성화 (텍스트 입력 중에도 상태만 유지) */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') setShiftDown(true)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') setShiftDown(false)
    }
    const onBlur = (): void => setShiftDown(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  /** 휠 줌 — 포인터 아래 문서 좌표를 고정한 채 stage.scale/position만 갱신 */
  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>): void => {
    e.evt.preventDefault()
    const pointer = stageRef.current?.getPointerPosition()
    if (!pointer) return
    interactedRef.current = true
    const factor = Math.exp(-e.evt.deltaY * ZOOM_SENSITIVITY)
    setView((prev) => {
      const scale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE)
      const ratio = scale / prev.scale
      if (ratio === 1) return prev
      return {
        scale,
        x: pointer.x - (pointer.x - prev.x) * ratio,
        y: pointer.y - (pointer.y - prev.y) * ratio
      }
    })
  }

  /** 팬 진행 중 뷰 동기화 — 자(ruler) 오버레이가 스테이지 드래그를 실시간 추적 */
  const handleDragMove = (e: Konva.KonvaEventObject<DragEvent>): void => {
    interactedRef.current = true
    setView((prev) => ({ ...prev, x: e.currentTarget.x(), y: e.currentTarget.y() }))
  }

  /** 팬 종료 — Konva 내장 드래그가 이동시킨 stage.position을 상태로 동기화 */
  const handleDragEnd = (e: Konva.KonvaEventObject<DragEvent>): void => {
    interactedRef.current = true
    setView((prev) => ({ ...prev, x: e.currentTarget.x(), y: e.currentTarget.y() }))
  }

  /** 휠 클릭 팬 진행 정보 — mousedown 시점 화면 좌표와 뷰 오프셋 스냅샷 */
  const wheelPanRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null)

  /**
   * Stage mousedown — 휠 클릭(중앙 버튼)은 어디에서나 팬 시작(Chromium 오토스크롤
   * 차단), 좌클릭 빈 곳은 마키(드래그 영역 선택) 시작. Ctrl 없이 시작하면 즉시 전체
   * 선택 해제(TC-6), Ctrl 드래그는 기존 선택에 합산. Space 팬 모드 중에는
   * 내비게이션이 우선한다.
   */
  const handleStageMouseDown = (e: Konva.KonvaEventObject<MouseEvent>): void => {
    if (e.evt.button === 1) {
      e.evt.preventDefault()
      const pointer = stageRef.current?.getPointerPosition()
      if (pointer) {
        wheelPanRef.current = { sx: pointer.x, sy: pointer.y, vx: view.x, vy: view.y }
        setPanning(true)
      }
      return
    }
    if (e.evt.button !== 0 || spaceDown) return
    const onEmpty = e.target === e.target.getStage() || e.target.name() === DOC_BACKGROUND
    if (!onEmpty) return
    const stage = stageRef.current
    const pointer = stage?.getPointerPosition()
    if (!pointer) return
    const additive = e.evt.ctrlKey || e.evt.metaKey
    const baseIds = additive ? selectedIds : []
    if (!additive) setSelectedIds([])
    const doc = screenToDoc(view, pointer.x, pointer.y)
    setMarquee({ start: doc, current: doc, baseIds, additive })
  }

  /** Stage mousemove — 휠 클릭 팬 우선 처리, 아니면 마키 진행(1px 교차 실시간 히트) */
  const handleStageMouseMove = (e: Konva.KonvaEventObject<MouseEvent>): void => {
    const pan = wheelPanRef.current
    const stage = e.target.getStage()
    const pointer = stage?.getPointerPosition()
    if (!pointer) return
    if (pan) {
      interactedRef.current = true
      setView((prev) => ({
        ...prev,
        x: pan.vx + (pointer.x - pan.sx),
        y: pan.vy + (pointer.y - pan.sy)
      }))
      return
    }
    if (!marquee) return
    const doc = screenToDoc(view, pointer.x, pointer.y)
    setMarquee((prev) => (prev ? { ...prev, current: doc } : prev))
    const hits = marqueeSelection(images, marquee.start, doc)
    // 그룹원을 건드리면 그룹 전체가 선택된다 (클릭 선택과 동일 규칙)
    setSelectedIds(
      expandSelectionToGroups(
        images,
        marquee.additive ? Array.from(new Set([...marquee.baseIds, ...hits])) : hits
      )
    )
  }

  /** 휠 클릭 팬 종료 — 릴리즈는 스테이지 밖에서도 놓치지 않도록 window에서 포착 */
  useEffect(() => {
    if (!panning) return
    const onMouseUp = (): void => {
      wheelPanRef.current = null
      setPanning(false)
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [panning])

  /**
   * 마키 종료 — 마우스 릴리즈는 스테이지 밖에서도 놓치지 않도록 window에서 포착.
   * 이동이 임계 미만이면 클릭으로 판정해 부가(Ctrl) 모드의 시작 시점 선택을 복원한다
   * (일반 모드는 mousedown에서 이미 해제 완료).
   */
  useEffect(() => {
    if (!marquee) return
    const onMouseUp = (): void => {
      const moved =
        Math.hypot(marquee.current.x - marquee.start.x, marquee.current.y - marquee.start.y) *
          view.scale >=
        MARQUEE_CLICK_PX
      if (!moved && marquee.additive) setSelectedIds(marquee.baseIds)
      setMarquee(null)
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [marquee, view.scale])

  /**
   * 우클릭 컨텍스트 메뉴 — 이미지 위: 미선택이면 선택(그룹 확장) 후 열기.
   * 트랜스포머 보더 등 선택 관련 영역: 선택 유지 채 열기. 빈 곳: 선택 해제·닫기.
   */
  const handleStageContextMenu = (e: Konva.KonvaEventObject<MouseEvent>): void => {
    e.evt.preventDefault()
    const hitId = e.target.id()
    const isImage = images.some((img) => img.id === hitId)
    const onEmpty = e.target === e.target.getStage() || e.target.name() === DOC_BACKGROUND
    if (isImage) {
      if (!selectedIds.includes(hitId)) handleSelect(hitId, false)
    } else if (onEmpty) {
      setSelectedIds([])
      setMenu(null)
      return
    }
    const rect = viewportRef.current?.getBoundingClientRect()
    setMenu({
      x: e.evt.clientX - (rect?.left ?? 0),
      y: e.evt.clientY - (rect?.top ?? 0)
    })
  }

  const menuRef = useRef<HTMLDivElement>(null)

  /** 메뉴 열림 중 바깥 mousedown·휠·창 블러·Esc 닫힘 — 메뉴 내부 클릭은 유지 */
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onMouseDown = (e: MouseEvent): void => {
      if (menuRef.current?.contains(e.target as Node) !== true) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('wheel', close, { passive: true })
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('wheel', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  /**
   * 이미지 클릭 선택 (TECH §4.2) — Ctrl/Cmd=토글(기존 선택 유지·개별 해제 TC-2/3),
   * 일반 클릭=단일 선택. 다중 선택 구성원 재클릭은 선택을 유지한다(그룹 이동 대비).
   * 그룹원을 건드리면 그룹 전체로 확장한다. Ctrl+클릭의 해제 토글은 mouseup까지
   * 지연한다 — 드래그로 이어지면 Ctrl+드래그 복제가 되므로.
   * Space 팬 모드 중에는 무시 (내비게이션 우선).
   */
  const handleSelect = useCallback(
    (id: string, additive: boolean): void => {
      if (spaceDown) return
      setMenu(null)
      gestureRef.current = { id, ctrl: additive }
      pendingToggleOffRef.current = null
      if (additive) {
        if (selectedIds.includes(id)) {
          pendingToggleOffRef.current = id
          return
        }
        setSelectedIds(expandSelectionToGroups(images, [...selectedIds, id]))
        return
      }
      if (selectedIds.includes(id)) return
      setSelectedIds(expandSelectionToGroups(images, [id]))
    },
    [spaceDown, images, selectedIds]
  )

  /** mouseup(무이동 클릭) — 지연된 Ctrl 토글 해제를 확정. 그룹원이면 그룹 전체 해제. */
  const handleSelectEnd = useCallback(
    (id: string): void => {
      const pending = pendingToggleOffRef.current
      pendingToggleOffRef.current = null
      if (pending !== id) return
      const groupId = images.find((img) => img.id === id)?.groupId
      setSelectedIds((prev) =>
        prev.filter(
          (sid) =>
            sid !== id &&
            !(groupId !== undefined && images.find((i) => i.id === sid)?.groupId === groupId)
        )
      )
    },
    [images]
  )

  /**
   * 노드 드래그 시작 — mousedown modifier(gestureRef)로 모드 결정.
   * Ctrl: 선택 항목 전체를 그 자리에 복제(히스토리 없이 씬에 추가, 그룹 id 재매핑)하고
   * 사본을 선택한 뒤 사본을 끄는 세션. 아니면 선택 항목 이동 세션.
   */
  const handleNodeDragStart = useCallback(
    (id: string): void => {
      // 한 마우스 제스처 = 첫 dragstart에서 확정된 단일 세션. 같은 제스처 중 다른 노드의
      // dragstart(외부 프록시가 강제 발화)는 기존 세션을 덮어쓰지 못하게 한다.
      if (dragRef.current !== null) return
      pendingToggleOffRef.current = null
      const gesture = gestureRef.current
      const locked = (sid: string): boolean => images.find((img) => img.id === sid)?.locked === true
      // 잠긴 항목은 드래그 대상에서 제외 — 미잠금 항목을 끌 때 함께 움직이지 않는다
      const targets = selectedIds.includes(id)
        ? selectedIds.filter((sid) => !locked(sid))
        : locked(id)
          ? []
          : [id]
      const targetImages = images.filter((img) => targets.includes(img.id))
      const dragged = images.find((img) => img.id === id)
      if (!dragged || targetImages.length === 0) return
      if (gesture?.id === id && gesture.ctrl && targetImages.length > 0) {
        const copies = cloneWithNewGroups(targetImages, { dx: 0, dy: 0 }, () =>
          crypto.randomUUID()
        ).map(stripLock)
        setImages((prev) => [...prev, ...copies])
        setSelectedIds(copies.map((copy) => copy.id))
        dragRef.current = {
          mode: 'duplicate',
          draggedId: id,
          base: new Map([
            [id, { x: dragged.x, y: dragged.y }],
            ...copies.map((copy) => [copy.id, { x: copy.x, y: copy.y }] as const)
          ]),
          preScene: images,
          selectionBefore: selectedIds,
          lastDelta: { dx: 0, dy: 0 },
          snap: {
            movingItems: copies.map(toSnapItem),
            // 복제 원본을 스냅 대상에서 제외 — 시작 직후 사본이 원본 위에서
            // threshold 이내로 끈적이듯 붙는 현상을 방지한다
            targets: buildSnapTargets(new Set(targetImages.map((img) => img.id))),
            threshold: SNAP_THRESHOLD_SCREEN_PX / view.scale
          }
        }
        return
      }
      dragRef.current = {
        mode: 'move',
        draggedId: id,
        base: new Map(targetImages.map((img) => [img.id, { x: img.x, y: img.y }])),
        preScene: images,
        selectionBefore: selectedIds,
        lastDelta: { dx: 0, dy: 0 },
        snap: {
          movingItems: targetImages.map(toSnapItem),
          targets: buildSnapTargets(new Set(targetImages.map((img) => img.id))),
          threshold: SNAP_THRESHOLD_SCREEN_PX / view.scale
        }
      }
    },
    [selectedIds, images, view.scale, buildSnapTargets]
  )

  /**
   * 노드 드래그 진행 — 드래그 노드의 델타를 나머지 대상에 즉시 반영.
   * Shift 홀드(Ctrl+Shift=수평·수직 복제, 일반 드래그=축 고정 이동)는 우세 축만 남긴다.
   * 스냅: 이동군 union의 에지·중심을 인접 항목·문서 가장자리에 붙이고 가이드를 띄운다.
   * duplicate 모드에서는 드래그 중인 원본을 제자리로 되돌리고 사본만 움직인다.
   */
  const handleNodeDragMove = useCallback((id: string, e: Konva.KonvaEventObject<DragEvent>) => {
    const session = dragRef.current
    if (!session || session.draggedId !== id) return
    const node = e.currentTarget
    const start = session.base.get(id)
    if (!start) return
    let dx = node.x() - start.x
    let dy = node.y() - start.y
    if (e.evt.shiftKey) {
      const constrained = constrainAxis(dx, dy)
      dx = constrained.dx
      dy = constrained.dy
    }
    if (session.snap) {
      const moved = session.snap.movingItems.map((it) => ({ ...it, x: it.x + dx, y: it.y + dy }))
      const snap = computeSnap(unionOfItems(moved), session.snap.targets, session.snap.threshold)
      dx += snap.dx
      dy += snap.dy
      setSnapOverlay(
        snap.guides.length > 0 || snap.labels.length > 0
          ? { guides: snap.guides, labels: snap.labels }
          : null
      )
    }
    session.lastDelta = { dx, dy }
    if (session.mode === 'move') {
      node.position({ x: start.x + dx, y: start.y + dy })
      for (const [otherId, pos] of session.base) {
        if (otherId === id) continue
        stageRef.current?.findOne(`#${otherId}`)?.position({ x: pos.x + dx, y: pos.y + dy })
      }
    } else {
      node.position(start)
      for (const [copyId, pos] of session.base) {
        if (copyId === id) continue
        stageRef.current?.findOne(`#${copyId}`)?.position({ x: pos.x + dx, y: pos.y + dy })
      }
    }
  }, [])

  /**
   * 노드 드래그 종료 — 한 번의 히스토리 커밋으로 확정.
   * move: 전체 새 위치 커밋(undo 1단계). duplicate: 원본을 제자리로 되돌리고 사본 위치를
   * 커밋하되 undo 기준은 복제 이전 씬(preScene) — 되돌리면 복제 자체가 사라진다.
   * 이동 없는 duplicate(클릭성)는 사본을 되돌리고 원래 선택을 복원한다.
   */
  const handleNodeDragEnd = useCallback(
    (id: string, x: number, y: number): void => {
      const session = dragRef.current
      dragRef.current = null
      gestureRef.current = null
      setSnapOverlay(null)
      if (!session || session.draggedId !== id) return
      const { dx, dy } = session.lastDelta
      if (session.mode === 'duplicate') {
        stageRef.current?.findOne(`#${id}`)?.position(session.base.get(id) ?? { x: x, y: y })
        if (dx === 0 && dy === 0) {
          setImages(session.preScene)
          setSelectedIds(session.selectionBefore)
          return
        }
        commitImages(
          (prev) =>
            prev.map((img) => {
              const base = session.base.get(img.id)
              return base && img.id !== id ? { ...img, x: base.x + dx, y: base.y + dy } : img
            }),
          session.preScene
        )
        return
      }
      if (dx === 0 && dy === 0) return
      const moves = new Map(session.base)
      for (const [otherId, pos] of session.base) {
        if (otherId !== id) moves.set(otherId, { x: pos.x + dx, y: pos.y + dy })
      }
      moves.set(id, { x, y })
      commitImages(
        (prev) =>
          prev.map((img) => {
            const moved = moves.get(img.id)
            return moved ? { ...img, ...moved } : img
          }),
        session.preScene
      )
    },
    [commitImages]
  )

  /** 이미지 트랜스폼 확정 — 임시 scale이 확정된 절대 px 치수를 히스토리 커밋 (Konva는 뷰일 뿐) */
  const handleTransform = useCallback(
    (id: string, reading: NodeTransformReading): void => {
      const commit = commitTransform(reading)
      commitImages((prev) => prev.map((img) => (img.id === id ? { ...img, ...commit } : img)))
    },
    [commitImages]
  )

  /** "맞춤" 버튼 — 문서 전체가 화면에 들어오도록 초기화 */
  const handleFit = useCallback((): void => {
    interactedRef.current = false
    setView(fitView(widthPx, heightPx, window.innerWidth, window.innerHeight))
  }, [widthPx, heightPx])

  /** 그리드 복제 확정 — 셀 (0,0)=원본 자리를 제외한 순수 JSON 사본 추가 (신규 id만 새로) */
  const handleGridConfirm = useCallback(
    (rows: number, cols: number, gapPx: number): void => {
      if (!selectedItem || selectedItem.locked) return
      const copies = calculateGridPositions(selectedItem, rows, cols, gapPx)
        .filter((cell) => cell.row > 0 || cell.col > 0)
        .map((cell) => ({
          ...stripLock(selectedItem),
          id: crypto.randomUUID(),
          x: cell.x,
          y: cell.y
        }))
      commitImages((prev) => [...prev, ...copies])
      setGridOpen(false)
    },
    [selectedItem, commitImages]
  )

  /** 화면 채우기(cover/contain) — fitToCanvas 순수 함수 결과를 히스토리 커밋 (undo 가능) */
  const handleFitMode = useCallback(
    (mode: FitMode): void => {
      if (!selectedItem || selectedItem.locked) return
      const commit = fitToCanvas(selectedItem, widthPx, heightPx, mode)
      commitImages((prev) =>
        prev.map((img) => (img.id === selectedItem.id ? { ...img, ...commit } : img))
      )
    },
    [selectedItem, widthPx, heightPx, commitImages]
  )

  /** 자동 배치 확정 (BATCH.md) — MaxRects 패킹 결과를 히스토리 커밋해 Ctrl+Z 복구 지원.
   *  미배치(캔버스 초과) 항목은 현재 위치를 그대로 둔다. */
  const handleNestingConfirm = useCallback(
    (gapCm: number, allowRotation: boolean): void => {
      const result = packImages(images, {
        canvasWidthPx: widthPx,
        canvasHeightPx: heightPx,
        gapCm,
        dpi: 350,
        allowRotation
      })
      setNestingOpen(false)
      if (result.packedItems.length === 0) return
      const placementById = new Map(result.packedItems.map((p) => [p.id, p]))
      commitImages((prev) =>
        prev.map((img) => {
          if (img.locked) return img // 잠긴 블록은 자동 배치가 침범하지 않는다
          const p = placementById.get(img.id)
          return p ? { ...img, x: p.x, y: p.y, rotation: p.rotation } : img
        })
      )
    },
    [images, widthPx, heightPx, commitImages]
  )

  /** 속성 패널 — 선택 항목 수치 편집 커밋 (cm→px 변환은 패널 담당, 여기선 절대 px만) */
  const handleUpdateSelected = useCallback(
    (patch: Partial<PlacedImage>): void => {
      if (!selectedItem || selectedItem.locked) return
      commitImages((prev) =>
        prev.map((img) => (img.id === selectedItem.id ? { ...img, ...patch } : img))
      )
    },
    [selectedItem, commitImages]
  )

  /** 속성 패널 90° 회전 버튼 — R 단축키와 동일 규칙 */
  const handleRotate90 = useCallback((): void => {
    if (!selectedItem || selectedItem.locked) return
    commitImages((prev) =>
      prev.map((img) =>
        img.id === selectedItem.id
          ? { ...img, rotation: normalizeRotation(img.rotation + 90) }
          : img
      )
    )
  }, [selectedItem, commitImages])

  /** 레이어 순서 — 배열 순서 = z순서 (뒤 index가 화면 위). 다중 선택은 상대 순서 유지
   *  일괄 이동(reorderItems), 잠긴 항목은 제외. 경계 no-op는 커밋하지 않아 빈 undo
   *  단계를 만들지 않는다. */
  const handleOrder = useCallback(
    (op: LayerOrderOp): void => {
      const ids = images
        .filter((img) => selectedIds.includes(img.id) && !img.locked)
        .map((img) => img.id)
      if (ids.length === 0) return
      const next = reorderItems(images, ids, op)
      if (next.every((img, i) => img === images[i])) return
      commitImages(() => next)
    },
    [images, selectedIds, commitImages]
  )

  /**
   * 정렬·분배 대상 — 선택에서 잠긴 항목과, 잠긴 멤버가 속한 그룹 전체를 제외한다
   * (그룹 일부만 움직여 그룹이 찢어지는 것 방지). groupId 없는 항목은 스스로 유닛.
   */
  const alignTargets = useMemo(() => {
    const lockedGroupIds = new Set(
      images
        .filter((img) => img.locked === true && img.groupId !== undefined)
        .map((img) => img.groupId)
    )
    return images.filter(
      (img) =>
        selectedIds.includes(img.id) &&
        img.locked !== true &&
        !(img.groupId !== undefined && lockedGroupIds.has(img.groupId))
    )
  }, [images, selectedIds])

  /** 정렬·분배 유닛 수 — 같은 그룹은 1유닛 (그룹 원자성, 분배 가능 판정 기준) */
  const alignUnitCount = useMemo(
    () => new Set(alignTargets.map((img) => img.groupId ?? img.id)).size,
    [alignTargets]
  )

  /**
   * 다중 선택 정렬·균등 분배 (TECH §4.3) — 순수 함수 결과를 한 번의 히스토리 커밋으로
   * 적용해 undo 1단계를 보장한다. 그룹은 원자 유닛으로 취급되어 내부 상대 위치가 불변.
   * 조건 미달(정렬 2·분배 3유닛)은 alignItems가 null로 no-op.
   */
  const handleAlign = useCallback(
    (op: AlignOp): void => {
      const moves = alignItems(alignTargets, op)
      if (!moves) return
      const movesById = new Map(moves.map((move) => [move.id, move]))
      commitImages((prev) =>
        prev.map((img) => {
          const move = movesById.get(img.id)
          return move ? { ...img, x: move.x, y: move.y } : img
        })
      )
    },
    [alignTargets, commitImages]
  )

  /**
   * 문서 기준 정렬 — 선택(1개 이상) union을 문서 가장자리·중앙에 맞춘다 (델타 기능).
   * 상대 정렬과 동일하게 순수 함수 → 히스토리 1커밋. 잠긴 멤버가 있는 그룹은 제외.
   */
  const handleDocAlign = useCallback(
    (op: DocAlignOp): void => {
      const moves = alignToDocument(alignTargets, op, widthPx, heightPx)
      if (!moves) return
      const movesById = new Map(moves.map((move) => [move.id, move]))
      commitImages((prev) =>
        prev.map((img) => {
          const move = movesById.get(img.id)
          return move ? { ...img, x: move.x, y: move.y } : img
        })
      )
    },
    [alignTargets, widthPx, heightPx, commitImages]
  )

  /**
   * 배경 제거(v2) — 선택 항목 전체(단일·다중)를 순차 처리해 RGBA PNG로 에셋 치환.
   * 시작 시점의 id·경로를 캡처해 처리 중 선택이 바뀌어도 올바른 항목을 갱신한다.
   * 완료분은 setImages로 즉시 캔버스에 반영(히스토리 미기록 — 대기 없는 순차 표시),
   * 히스토리 커밋은 배치 전체를 마친 뒤 1회(undo 기준 = 시작 시점 씬)로 유지해
   * 배치 전체가 undo 1단계로 되돌려지는 기존 계약을 보존한다.
   * 치환 정책상 내보내기 파이프라인은 무수정 재사용된다(알파→백색 잉크 마스크).
   * Auto-Trim ON이면 결과의 투명 여백을 알파 바운딩 박스로 잘라 치환한다 —
   * 여백이 남으면 항목 크기가 캔버스 전체 기준이 되어 복제 시 이미지끼리 멀어진다.
   */
  const handleRemoveBg = useCallback((): void => {
    const targets = images
      .filter((img) => selectedIds.includes(img.id) && !img.locked)
      .map((img) => ({ id: img.id, filePath: img.filePath }))
    if (targets.length === 0 || removeBusy) return
    setRemoveBusy(true)
    setRemoveProgress({ current: 0, total: targets.length })
    void (async (): Promise<void> => {
      const done: RemovedBgEntry[] = []
      const failures: string[] = []
      for (const [index, target] of targets.entries()) {
        try {
          const result = await window.api.removeBackground(target.filePath)
          let filePath = result.filePath
          let dataUrl = result.dataUrl
          let trimmed: RemovedBgEntry['trimmed'] = null
          if (autoTrim) {
            const t = await window.api.autoTrimImage(filePath).catch(() => null)
            if (t && t.trimmed) {
              filePath = t.filePath
              dataUrl = t.dataUrl
              trimmed = { widthPx: t.widthPx, heightPx: t.heightPx }
            }
          }
          const entry: RemovedBgEntry = {
            id: target.id,
            filePath,
            dataUrl,
            srcWidthPx: result.widthPx,
            srcHeightPx: result.heightPx,
            trimmed
          }
          done.push(entry)
          setImages((prev) =>
            prev.map((img) => (img.id === entry.id ? applyRemovedBg(img, entry) : img))
          )
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err))
        }
        setRemoveProgress({ current: index + 1, total: targets.length })
      }
      if (done.length > 0) {
        const doneById = new Map(done.map((entry) => [entry.id, entry]))
        commitImages((prev) =>
          prev.map((img) => {
            const entry = doneById.get(img.id)
            return entry ? applyRemovedBg(img, entry) : img
          })
        )
      }
      setRemoveBusy(false)
      setRemoveProgress(null)
      if (failures.length > 0) {
        alert(`배경 제거 실패 ${failures.length}/${targets.length}건:\n${failures.join('\n')}`)
      }
    })()
  }, [images, selectedIds, removeBusy, autoTrim, setImages, commitImages])

  /**
   * 업스케일 완료 치환 — 결과(DPI 메타 포함 PNG)를 새 에셋으로 교체한다(removeBg
   * 치환 정책). 치수는 결과 물리 DPI 기준 문서 px로 환산하고, 기존 씬 배치의
   * 중심점을 유지해 x/y를 보정한다(확대 후에도 피사체가 제자리에 보임).
   */
  const handleUpscaleDone = useCallback(
    (result: UpscaledImage): void => {
      setUpscaleTarget((target) => {
        if (target !== null) {
          const newW = physicalDocPixels(result.widthPx, result.dpi)
          const newH = physicalDocPixels(result.heightPx, result.dpi)
          commitImages((prev) =>
            prev.map((img) =>
              img.id === target.id
                ? {
                    ...img,
                    filePath: result.filePath,
                    dataUrl: result.dataUrl,
                    widthPx: newW,
                    heightPx: newH,
                    x: img.x + (img.widthPx - newW) / 2,
                    y: img.y + (img.heightPx - newH) / 2
                  }
                : img
            )
          )
        }
        return null
      })
    },
    [commitImages]
  )

  /** 경로들을 기준점 중심에 캐스케이드 배치해 씬에 추가 — 원본 DPI 메타데이터가
   *  있으면 물리 크기(실제 cm)를 보존해 350 DPI 문서 px으로 환산해 배치한다.
   *  Auto-Trim 켜짐: 먼저 알파 바운딩 박스로 크롭된 PNG를 새 원본으로 삼는다
   *  (완전 투명·여백 없음이면 사이드카가 원본을 그대로 돌려준다). 앵커 갱신 —
   *  centeredTopLeft가 "잘린 후 치수"로 좌상단을 다시 계산하므로 보이는 피사체의
   *  중심이 기준점(드롭 지점·뷰 중심)에 그대로 유지되고 width/height만 갱신된다.
   *  트림 실패(사이드카 오류)는 원본 임포트로 폴백 — 기능 장애가 가져오기를 막지 않게. */
  const importPaths = useCallback(
    async (paths: string[], center: DocPoint): Promise<void> => {
      try {
        const placed: PlacedImage[] = []
        for (let i = 0; i < paths.length; i++) {
          const trimmed = autoTrim
            ? await window.api.autoTrimImage(paths[i]).catch(() => null)
            : null
          const imported: ImportedImage = trimmed ?? (await window.api.importImage(paths[i]))
          const docWidthPx = physicalDocPixels(imported.widthPx, imported.dpi)
          const docHeightPx = physicalDocPixels(imported.heightPx, imported.dpi)
          const topLeft = centeredTopLeft(docWidthPx, docHeightPx, center, i, view.scale)
          placed.push({
            id: crypto.randomUUID(),
            filePath: trimmed?.filePath ?? paths[i],
            dataUrl: imported.dataUrl,
            widthPx: docWidthPx,
            heightPx: docHeightPx,
            x: topLeft.x,
            y: topLeft.y,
            rotation: 0
          })
        }
        commitImages((prev) => [...prev, ...placed])
      } catch (err) {
        alert(`이미지 가져오기 실패: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [autoTrim, view.scale, commitImages]
  )

  /**
   * E2E 자동검증 훅 (DTF_SMOKE_TEST 패턴 계승) — dtf:import-paths 커스텀 이벤트로
   * 파일 대화상자(자동화 불가) 없이 씬에 이미지를 주입한다. 렌더러 내부 경로라
   * 일반 사용 중에는 발생하지 않는다.
   */
  useEffect(() => {
    const onImportPaths = (e: Event): void => {
      const paths = (e as CustomEvent<string[]>).detail
      if (Array.isArray(paths) && paths.length > 0) {
        void importPaths(paths, viewCenterDoc(view, size.w, size.h))
      }
    }
    window.addEventListener('dtf:import-paths', onImportPaths)
    return () => window.removeEventListener('dtf:import-paths', onImportPaths)
  }, [importPaths, view, size])

  /** 파일 대화상자 임포트 — 현재 뷰 중심에 배치 */
  const handleImport = useCallback((): void => {
    void window.api.openImages().then((paths) => {
      if (!paths || paths.length === 0) return
      void importPaths(paths, viewCenterDoc(view, size.w, size.h))
    })
  }, [importPaths, view, size])

  /** 드래그앤드롭 — 드롭 지점(뷰포트 기준 → 문서 좌표)을 기준점으로 배치 */
  const handleDrop = useCallback(
    (e: React.DragEvent): void => {
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      const paths = Array.from(e.dataTransfer.files).flatMap((file) => {
        try {
          const p = window.api.getPathForFile(file)
          return p.length > 0 ? [p] : []
        } catch {
          return []
        }
      })
      if (paths.length === 0) return
      void importPaths(paths, screenToDoc(view, e.clientX - rect.left, e.clientY - rect.top))
    },
    [importPaths, view]
  )

  const zoomPercent = Math.round(view.scale * 100)
  const selectedImages = images.filter((img) => selectedIds.includes(img.id))
  const anySelectedUnlocked = selectedImages.some((img) => img.locked !== true)
  const canGroupMenu = selectedImages.length >= 2 && !isSingleCompleteGroup(images, selectedIds)
  const canUngroupMenu = selectedImages.some((img) => img.groupId !== undefined)
  const selectedIndex =
    selectedIds.length === 1 ? images.findIndex((img) => img.id === selectedIds[0]) : -1
  const isSingleSelection = selectedIds.length === 1
  const selectionStrokeWidth = 2 / view.scale
  const gridV = useMemo(
    () => gridLinePositions(widthPx, gridSettings.intervalCm),
    [widthPx, gridSettings.intervalCm]
  )
  const gridH = useMemo(
    () => gridLinePositions(heightPx, gridSettings.intervalCm),
    [heightPx, gridSettings.intervalCm]
  )

  return (
    <div
      className="fixed inset-0 flex overflow-hidden bg-zinc-950"
      style={{ cursor: panning ? 'grabbing' : spaceDown ? 'grab' : 'default' }}
    >
      <div
        ref={viewportRef}
        className="relative min-w-0 flex-1"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        <Stage
          ref={stageRef}
          width={size.w}
          height={size.h}
          scaleX={view.scale}
          scaleY={view.scale}
          x={view.x}
          y={view.y}
          draggable={spaceDown}
          onWheel={handleWheel}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
          onMouseDown={handleStageMouseDown}
          onMouseMove={handleStageMouseMove}
          onContextMenu={handleStageContextMenu}
        >
          <Layer>
            {/* 가상 문서 — 실규격 350 DPI 좌표계의 흰색 Rect (테두리는 화면 2px 유지) */}
            <Rect
              name={DOC_BACKGROUND}
              x={0}
              y={0}
              width={widthPx}
              height={heightPx}
              fill="#ffffff"
              stroke="#52525b"
              strokeWidth={2 / view.scale}
              perfectDrawEnabled={false}
            />
          </Layer>
          {checkerBg && checkerPattern && (
            <Layer listening={false}>
              {/* 체커보드 배경 — 투명 영역 표시 관례. 표시 전용 보기 옵션이라 내보내기와
                  무관하며, 스테이지 배율 역보정으로 화면 기준 셀 크기를 일정하게 유지 */}
              <Shape
                sceneFunc={(ctx) => {
                  const pattern = ctx.createPattern(checkerPattern, 'repeat')
                  if (!pattern) return
                  ctx.save()
                  ctx.scale(1 / view.scale, 1 / view.scale)
                  ctx.fillStyle = pattern
                  ctx.fillRect(0, 0, widthPx * view.scale, heightPx * view.scale)
                  ctx.restore()
                }}
                perfectDrawEnabled={false}
              />
            </Layer>
          )}
          {gridSettings.visible && (
            <Layer listening={false}>
              {/* 격자 오버레이 — 단일 Shape에 전체 경로를 한 번에 그린다(노드 수 폭주 방지).
                  대시·스트로크는 1/scale 보정으로 줌과 무관한 화면 1px 두께 유지 */}
              <Shape
                sceneFunc={(ctx, shape) => {
                  ctx.beginPath()
                  for (const x of gridV) {
                    ctx.moveTo(x, 0)
                    ctx.lineTo(x, heightPx)
                  }
                  for (const y of gridH) {
                    ctx.moveTo(0, y)
                    ctx.lineTo(widthPx, y)
                  }
                  ctx.strokeShape(shape)
                }}
                stroke={gridSettings.color}
                strokeWidth={1 / view.scale}
                dash={gridDash(gridSettings.lineStyle, view.scale)}
                lineCap={gridSettings.lineStyle === 'dotted' ? 'round' : 'butt'}
                perfectDrawEnabled={false}
              />
            </Layer>
          )}
          <Layer>
            {images.map((placed) => (
              <SceneImage
                key={placed.id}
                placed={placed}
                draggable={!spaceDown}
                selected={selectedIds.includes(placed.id)}
                selectionStrokeWidth={selectionStrokeWidth}
                onSelect={handleSelect}
                onSelectEnd={handleSelectEnd}
                onDragStart={handleNodeDragStart}
                onDragMove={handleNodeDragMove}
                onDragEnd={handleNodeDragEnd}
                onTransform={handleTransform}
              />
            ))}
            {/* 씬 전체 유일 트랜스포머 — 1개 선택: 모서리 4핸들(비율 유지 기본, Shift=자유
                비율) + 회전 앵커(Shift 홀드=15° 배수 스냅) · 2개 이상: 합집합 보더만
                (이동은 노드 드래그 동기화). 트랜스포머는 절대(화면) 좌표계로 렌더 —
                앵커·스트로크는 줌 배율과 무관하게 화면 px */}
            <Transformer
              ref={transformerRef}
              resizeEnabled={isSingleSelection}
              rotateEnabled={isSingleSelection}
              keepRatio
              shiftBehavior="inverted"
              rotationSnaps={shiftDown ? ROTATION_SNAPS : []}
              rotationSnapTolerance={7}
              enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
              boundBoxFunc={boundMinSize}
              borderStroke={SELECTION_STROKE}
              borderStrokeWidth={2}
              anchorStroke={SELECTION_STROKE}
            />
          </Layer>
          {snapOverlay && (
            <Layer listening={false}>
              {/* 드래그 스냅 가이드 — 정렬 성립 라인 + 인접 항목·문서와의 간격(mm) 라벨 */}
              {snapOverlay.guides.map((guide, i) => (
                <Line
                  key={`snap-guide-${i}`}
                  points={
                    guide.axis === 'x'
                      ? [guide.position, guide.from, guide.position, guide.to]
                      : [guide.from, guide.position, guide.to, guide.position]
                  }
                  stroke={SNAP_GUIDE_STROKE}
                  strokeWidth={1 / view.scale}
                  dash={[6 / view.scale, 4 / view.scale]}
                  perfectDrawEnabled={false}
                />
              ))}
              {snapOverlay.labels.map((label, i) => {
                const text = `${pxToMm(label.gapPx).toFixed(1)}mm`
                const fontSize = 36 / view.scale
                return (
                  <Text
                    key={`snap-label-${i}`}
                    x={label.x - (text.length * fontSize * 0.62) / 2}
                    y={label.y - fontSize * 0.7}
                    text={text}
                    fontSize={fontSize}
                    fontFamily="ui-monospace, monospace"
                    fill="#ecfeff"
                    stroke="#155e75"
                    strokeWidth={2.5 / view.scale}
                    fillAfterStrokeEnabled
                    perfectDrawEnabled={false}
                  />
                )
              })}
            </Layer>
          )}
          {marquee && (
            <Layer listening={false}>
              {/* 마키 선택 박스 — 반투명 채움 + 대시 보더 (TECH §2.1 실시간 피드백) */}
              <Rect
                x={Math.min(marquee.start.x, marquee.current.x)}
                y={Math.min(marquee.start.y, marquee.current.y)}
                width={Math.abs(marquee.current.x - marquee.start.x)}
                height={Math.abs(marquee.current.y - marquee.start.y)}
                fill="rgba(99,102,241,0.08)"
                stroke={SELECTION_STROKE}
                strokeWidth={1 / view.scale}
                dash={[4 / view.scale, 4 / view.scale]}
                perfectDrawEnabled={false}
              />
            </Layer>
          )}
        </Stage>

        {/* 문서 바깥 자 — 상단(가로 cm)·좌측(세로 cm), 문서 범위 하이라이트 포함 */}
        <RulerOverlay
          view={view}
          viewportW={size.w}
          viewportH={size.h}
          docW={widthPx}
          docH={heightPx}
        />

        {/* 문서 이름 — 열거나 저장한 .dtf 파일명 (새 문서는 "제목 없음") */}
        <div className="absolute left-3 top-8 flex select-none items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-300">
          <span className="max-w-[240px] truncate font-medium" title={projectFileName ?? undefined}>
            {projectFileName ?? '제목 없음'}
          </span>
          <span className="text-zinc-600">.dtf</span>
        </div>

        {/* 상태 오버레이: 문서 치수 · 현재 배율 · 툴바 — 상단 자(22px) 아래에 위치 */}
        <div className="absolute right-3 top-8 flex select-none items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] tabular-nums text-zinc-400">
            <span>
              {widthPx.toLocaleString()} × {heightPx.toLocaleString()} px
            </span>
            <span className="font-semibold text-zinc-200">{zoomPercent}%</span>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/95 p-1 shadow-2xl backdrop-blur">
            <OverlayButton onClick={onNewProject} title="새 파일 — 새 문서 규격으로 시작">
              <FilePlus2 size={14} strokeWidth={1.5} />새 파일
            </OverlayButton>
            <OverlayButton onClick={onOpenProject} title="프로젝트 열기 (.dtf)">
              <FolderOpen size={14} strokeWidth={1.5} />
              열기
            </OverlayButton>
            <OverlayButton onClick={handleImport} title="이미지 가져오기">
              <ImagePlus size={14} strokeWidth={1.5} />
              가져오기
            </OverlayButton>
            <OverlayButton
              onClick={toggleAutoTrim}
              active={autoTrim}
              title="투명 여백 자동 제거 (Auto-Trim) — 이미지 가져오기 시 알파 경계로 잘라 배치 (토글)"
            >
              <Scissors size={14} strokeWidth={1.5} />
              여백 제거
            </OverlayButton>
            <OverlayButton onClick={() => void handleSave()} title="프로젝트 저장 (.dtf) — Ctrl+S">
              <Save size={14} strokeWidth={1.5} />
              저장
            </OverlayButton>
            <div className="mx-0.5 h-5 w-px bg-zinc-800" />
            <OverlayButton
              onClick={() => setGridOpen(true)}
              disabled={!selectedItem || selectedItem.locked === true}
              title="이미지 복제"
            >
              <Grid3x3 size={14} strokeWidth={1.5} />
              이미지 복제
            </OverlayButton>
            <OverlayButton
              onClick={() => setGridSettingsOpen(true)}
              active={gridSettings.visible}
              title="그리드 표시 설정 (간격·색·선 스타일)"
            >
              <Grid2x2 size={14} strokeWidth={1.5} />
              그리드
            </OverlayButton>
            <OverlayButton
              onClick={() => setCheckerBg((v) => !v)}
              active={checkerBg}
              title="문서 배경 체커보드 토글 — 흰색 배경 이미지 경계 식별 (표시 전용)"
            >
              <LayoutGrid size={14} strokeWidth={1.5} />
              배경
            </OverlayButton>
            <OverlayButton
              onClick={() => handleFitMode('cover')}
              disabled={!selectedItem || selectedItem.locked === true}
              title="화면 채우기 (cover)"
            >
              <Expand size={14} strokeWidth={1.5} />
              채우기
            </OverlayButton>
            <OverlayButton
              onClick={() => handleFitMode('contain')}
              disabled={!selectedItem || selectedItem.locked === true}
              title="안에 맞춤 (contain)"
            >
              <Shrink size={14} strokeWidth={1.5} />
              안에 맞춤
            </OverlayButton>
            <div className="mx-0.5 h-5 w-px bg-zinc-800" />
            <OverlayButton
              onClick={() => setNestingOpen(true)}
              disabled={images.length === 0}
              title="자동 배치 (MaxRects 밀집 패킹)"
            >
              <Boxes size={14} strokeWidth={1.5} />
              자동 배치
            </OverlayButton>
            <div className="mx-0.5 h-5 w-px bg-zinc-800" />
            <OverlayButton onClick={undo} disabled={!canUndo} title="실행취소 (Ctrl+Z)">
              <Undo2 size={14} strokeWidth={1.5} />
              실행취소
            </OverlayButton>
            <OverlayButton onClick={redo} disabled={!canRedo} title="다시실행 (Ctrl+Shift+Z)">
              <Redo2 size={14} strokeWidth={1.5} />
              다시실행
            </OverlayButton>
            <div className="mx-0.5 h-5 w-px bg-zinc-800" />
            <OverlayButton onClick={handleFit} title="문서 전체 화면 맞춤">
              <Maximize size={14} strokeWidth={1.5} />
              맞춤
            </OverlayButton>
            <div className="mx-0.5 h-5 w-px bg-zinc-800" />
            <OverlayButton
              onClick={() => setExportOpen(true)}
              disabled={images.length === 0}
              title="내보내기 (PSD·PNG)"
              primary
            >
              <FileOutput size={14} strokeWidth={1.5} />
              내보내기
            </OverlayButton>
          </div>
        </div>

        {gridOpen && selectedItem && (
          <GridDialog
            item={selectedItem}
            widthPx={widthPx}
            heightPx={heightPx}
            onConfirm={handleGridConfirm}
            onClose={() => setGridOpen(false)}
          />
        )}

        {gridSettingsOpen && (
          <GridSettingsDialog
            settings={gridSettings}
            onChange={setGridSettings}
            onClose={() => setGridSettingsOpen(false)}
          />
        )}

        {bgSitesOpen && <BgSitesDialog onClose={() => setBgSitesOpen(false)} />}
        {upscaleTarget !== null && (
          <UpscaleDialog
            filePath={upscaleTarget.filePath}
            onClose={() => setUpscaleTarget(null)}
            onDone={handleUpscaleDone}
          />
        )}

        {nestingOpen && images.length > 0 && (
          <NestingDialog
            items={images}
            widthPx={widthPx}
            heightPx={heightPx}
            onConfirm={handleNestingConfirm}
            onClose={() => setNestingOpen(false)}
          />
        )}

        {exportOpen && (
          <ExportDialog
            items={images}
            widthPx={widthPx}
            heightPx={heightPx}
            onClose={() => setExportOpen(false)}
          />
        )}

        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            viewportW={size.w}
            viewportH={size.h}
            selectionCount={selectedImages.length}
            canGroup={canGroupMenu}
            canUngroup={canUngroupMenu}
            alignUnitCount={alignUnitCount}
            anyUnlocked={anySelectedUnlocked}
            rootRef={menuRef}
            onDuplicate={() => {
              setMenu(null)
              handleDuplicate()
            }}
            onDelete={() => {
              setMenu(null)
              handleDeleteSelection()
            }}
            onToggleLock={() => {
              setMenu(null)
              handleToggleLock()
            }}
            onGroup={() => {
              setMenu(null)
              handleGroup()
            }}
            onUngroup={() => {
              setMenu(null)
              handleUngroup()
            }}
            onAlign={(op) => {
              setMenu(null)
              handleAlign(op)
            }}
            onDocAlign={(op) => {
              setMenu(null)
              handleDocAlign(op)
            }}
            onOrder={(op) => {
              setMenu(null)
              handleOrder(op)
            }}
          />
        )}

        {/* 조작 힌트 + 방향키 이동 거리 스텝퍼 */}
        <div className="absolute bottom-3 left-3 flex select-none items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900/95 px-3 py-1.5 text-[11px] text-zinc-500 backdrop-blur">
          <div className="leading-relaxed">
            휠: 줌 · Space/휠 클릭 + 드래그: 팬 · 드래그: 이동(인접 항목·문서 가장자리 자동 스냅) ·
            Shift 드래그: 축 고정 · Ctrl+드래그: 복제 · 빈 곳 드래그: 영역 선택 · 우클릭:
            메뉴(정렬·문서 정렬·레이어·잠금) · 방향키: 이동(Shift: 1mm) · Ctrl+G: 그룹 ·
            Ctrl+D/C/X/V: 복제/복사/잘라내기/붙여넣기 · Ctrl+L: 잠금 · R: 90° 회전 · Shift+회전: 15°
            · Del: 삭제 · Ctrl+Z/Y: 실행취소·다시실행 · 이미지 드롭: 배치
          </div>
          <div className="flex items-center gap-1 border-l border-zinc-800 pl-3">
            <span className="text-zinc-400">방향키 이동</span>
            <button
              type="button"
              aria-label="이동 거리 1mm 감소"
              disabled={nudgeStepMm <= NUDGE_MIN_MM}
              onClick={() => setNudgeStepMm((v) => Math.max(NUDGE_MIN_MM, v - 1))}
              className="flex h-5 w-5 items-center justify-center rounded border border-zinc-800 bg-zinc-900 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
            >
              <Minus size={11} strokeWidth={2} />
            </button>
            <span className="w-10 text-center tabular-nums text-zinc-200">{nudgeStepMm} mm</span>
            <button
              type="button"
              aria-label="이동 거리 1mm 증가"
              disabled={nudgeStepMm >= NUDGE_MAX_MM}
              onClick={() => setNudgeStepMm((v) => Math.min(NUDGE_MAX_MM, v + 1))}
              className="flex h-5 w-5 items-center justify-center rounded border border-zinc-800 bg-zinc-900 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
            >
              <Plus size={11} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>

      <PropertiesPanel
        item={selectedItem}
        itemCount={images.length}
        selectedIndex={selectedIndex >= 0 ? selectedIndex : null}
        multiSelectedCount={selectedIds.length}
        alignUnitCount={alignUnitCount}
        onAlign={handleAlign}
        onDocAlign={handleDocAlign}
        onUpdate={handleUpdateSelected}
        onRotate90={handleRotate90}
        onOrder={handleOrder}
        onToggleLock={handleToggleLock}
        onOpenGrid={() => setGridOpen(true)}
        onRemoveBg={handleRemoveBg}
        removeBusy={removeBusy}
        removeProgress={removeProgress}
        onOpenBgSites={() => setBgSitesOpen(true)}
        onOpenUpscale={() => {
          if (selectedItem)
            setUpscaleTarget({ id: selectedItem.id, filePath: selectedItem.filePath })
        }}
      />
    </div>
  )
}

interface SceneImageProps {
  placed: PlacedImage
  /** Space 팬 모드 중 false — stage 드래그가 우선한다 */
  draggable: boolean
  /** 다중 선택 구성원 여부 — 선택 테두리(스트로크) 렌더 */
  selected: boolean
  /** 선택 스트로크 두께(절대 px) — 줌 배율 역보정값(화면 2px 고정)을 호출자가 계산해 전달 */
  selectionStrokeWidth: number
  onSelect: (id: string, additive: boolean) => void
  /** mouseup(무이동) — Ctrl 토글 해제 지연 확정 */
  onSelectEnd: (id: string) => void
  onDragStart: (id: string) => void
  onDragMove: (id: string, e: Konva.KonvaEventObject<DragEvent>) => void
  onDragEnd: (id: string, x: number, y: number) => void
  onTransform: (id: string, reading: NodeTransformReading) => void
}

interface OverlayButtonProps {
  onClick: () => void
  disabled?: boolean
  title?: string
  primary?: boolean
  /** 활성 상태 강조 (토글성 버튼 — 그리드 표시 등) */
  active?: boolean
  children: React.ReactNode
}

/** 오버레이 버튼 — disabled 시 기존 관례(투명도 0.4·포인터 차단) 적용 */
function OverlayButton({
  onClick,
  disabled = false,
  title,
  primary = false,
  active = false,
  children
}: OverlayButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors active:scale-95 disabled:pointer-events-none disabled:opacity-40 ${
        primary
          ? 'border border-indigo-500 bg-indigo-600 font-medium text-white hover:bg-indigo-500'
          : active
            ? 'border border-indigo-500 bg-indigo-500/15 font-medium text-indigo-300 hover:bg-indigo-500/25'
            : 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100'
      }`}
    >
      {children}
    </button>
  )
}

/** 씬 이미지 노드 — 원본 px 크기 그대로 렌더. mousedown으로 즉선택(Ctrl=토글) 후 드래그 이동 */
function SceneImage({
  placed,
  draggable,
  selected,
  selectionStrokeWidth,
  onSelect,
  onSelectEnd,
  onDragStart,
  onDragMove,
  onDragEnd,
  onTransform
}: SceneImageProps): React.JSX.Element | null {
  const el = useHtmlImage(placed.dataUrl)
  if (!el) return null
  return (
    <Image
      id={placed.id}
      x={placed.x}
      y={placed.y}
      rotation={placed.rotation}
      width={placed.widthPx}
      height={placed.heightPx}
      image={el}
      draggable={draggable && placed.locked !== true}
      stroke={selected ? (placed.locked ? LOCKED_STROKE : SELECTION_STROKE) : undefined}
      strokeWidth={selected ? selectionStrokeWidth : undefined}
      strokeHitEnabled={false}
      onMouseDown={(e) => onSelect(placed.id, e.evt.ctrlKey || e.evt.metaKey)}
      onMouseUp={() => onSelectEnd(placed.id)}
      onDragStart={() => onDragStart(placed.id)}
      onDragMove={(e) => onDragMove(placed.id, e)}
      onDragEnd={(e) => onDragEnd(placed.id, e.currentTarget.x(), e.currentTarget.y())}
      onTransformEnd={(e) => {
        // 트랜스포머는 리사이즈를 임시 scaleX/scaleY로 적용한다. 판독 직후 노드에 1로 리셋 —
        // react-konva는 prop으로 전달하지 않은 scale을 다음 렌더에서 되돌리지 않는다 (Konva 공식 패턴)
        const node = e.currentTarget
        const scaleX = node.scaleX()
        const scaleY = node.scaleY()
        node.scaleX(1)
        node.scaleY(1)
        onTransform(placed.id, {
          x: node.x(),
          y: node.y(),
          rotation: node.rotation(),
          width: node.width(),
          height: node.height(),
          scaleX,
          scaleY
        })
      }}
      perfectDrawEnabled={false}
    />
  )
}
