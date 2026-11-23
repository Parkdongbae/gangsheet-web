import { useCallback, useEffect, useState } from 'react'
import {
  ArrowRight,
  ChevronDown,
  FileOutput,
  FolderOpen,
  History,
  ImagePlus,
  Layers,
  Ruler,
  ShieldCheck
} from 'lucide-react'
import {
  DTF_WIDTH_CM,
  FIXED_SHEET_PRESETS,
  HEIGHT_PRESETS_M,
  WIDTH_PRESETS_CM,
  cmToPx,
  getCanvasHeightPx,
  getCanvasWidthPx,
  type FixedSheetPreset,
  type HeightPresetM
} from '../../core/math'
import type { ResumableSession } from '../../types/ipc'
import { ProxyCanvas, type PlacedImage } from './components/canvas/ProxyCanvas'
import { ThemeToggle } from './components/ThemeToggle'
import { hydrateProjectImages } from './projectIO'
import heroUrl from './assets/hero.webp'
import './theme'

/** 작업 세션 — 문서 규격 + 씬 이미지 + 문서 이름. nonce 증가 = 프로젝트 불러오기로 전체 교체 */
interface DocumentSession {
  widthPx: number
  heightPx: number
  images: PlacedImage[]
  nonce: number
  /** 열거나 저장한 .dtf 파일 이름 (확장자 제외) — 새 문서는 null */
  fileName: string | null
}

/** 새 문서 규격 선택 — 롤(폭×길이) 또는 고정 시트(A4/A3) */
type SheetKind = 'roll' | FixedSheetPreset['id']

/** 자주 쓰는 롤 폭 바로 선택 (cm) */
const QUICK_WIDTHS_CM = [30, 50, 60, 100] as const

const fileBaseName = (filePath: string): string =>
  filePath
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.[^.]+$/, '') ?? filePath

const pxToCmLabel = (px: number): string => String(Math.round((px / 350) * 2.54 * 10) / 10)

function formatSavedAt(savedAt: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - savedAt) / 60000))
  if (minutes < 1) return '방금 전'
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  return `${Math.round(hours / 24)}일 전`
}

const STEPS = [
  { icon: Ruler, title: '규격 고르기', body: '필름 폭과 길이만 정하면 준비 끝' },
  { icon: ImagePlus, title: '이미지 올리기', body: '끌어다 놓고 자동 배치로 빈틈없이' },
  { icon: FileOutput, title: '내보내기', body: '인쇄소 규격 PSD · PNG · PDF로 저장' }
] as const

function App(): React.JSX.Element {
  const [sheetKind, setSheetKind] = useState<SheetKind>('roll')
  const [widthCm, setWidthCm] = useState<number>(DTF_WIDTH_CM)
  const [heightM, setHeightM] = useState<HeightPresetM>(1)
  const [doc, setDoc] = useState<DocumentSession | null>(null)
  const [resumable, setResumable] = useState<ResumableSession | null>(null)

  const fixedPreset =
    sheetKind === 'roll' ? null : (FIXED_SHEET_PRESETS.find((p) => p.id === sheetKind) ?? null)
  const widthPx = fixedPreset ? cmToPx(fixedPreset.widthCm) : getCanvasWidthPx(widthCm)
  const heightPx = fixedPreset ? cmToPx(fixedPreset.heightCm) : getCanvasHeightPx(heightM)
  const summaryCm = fixedPreset
    ? `${fixedPreset.widthCm} × ${fixedPreset.heightCm} cm`
    : `${widthCm} × ${heightM * 100} cm`

  /** .dtf 프로젝트 열기 — 프리뷰 재생성(hydrate) 후 세션 교체 (새 문서 만들기와 동일 경로) */
  const openProjectFromDisk = useCallback(async (pathOverride?: string): Promise<void> => {
    try {
      const opened = await window.api.openProject(pathOverride)
      if (!opened) return
      const images = await hydrateProjectImages(opened.data.images)
      setDoc((prev) => ({
        widthPx: opened.data.document.widthPx,
        heightPx: opened.data.document.heightPx,
        images,
        nonce: (prev?.nonce ?? 0) + 1,
        fileName: fileBaseName(opened.filePath)
      }))
    } catch (err) {
      alert(`프로젝트 열기 실패: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  /** 툴바 "새 파일" — 진행 중 세션 폐기 후 새 문서 설정 화면으로 돌아간다 (미저장 경고) */
  const handleNewProject = useCallback((): void => {
    if (
      !window.confirm(
        '현재 작업 내용을 버리고 새 문서를 만들까요?\n저장하지 않은 변경 사항은 사라집니다.'
      )
    )
      return
    setDoc(null)
  }, [])

  /** 문서 이름 갱신 — Ctrl+S 저장 완료 시 저장 경로의 파일명으로 */
  const handleFileNameChange = useCallback((name: string): void => {
    setDoc((prev) => (prev ? { ...prev, fileName: name } : prev))
  }, [])

  /** E2E 자동검증 훅 (dtf:import-paths 패턴 계승) — 파일 다이얼로그 없이 경로로 프로젝트를 연다 */
  useEffect(() => {
    const onOpenProject = (e: Event): void => {
      const path = (e as CustomEvent<string>).detail
      if (typeof path === 'string' && path.length > 0) void openProjectFromDisk(path)
    }
    window.addEventListener('dtf:open-project', onOpenProject)
    return () => window.removeEventListener('dtf:open-project', onOpenProject)
  }, [openProjectFromDisk])

  /** 시작 화면에 올 때마다 직전 작업(자동저장) 조회 — "이어서 작업하기" 카드 */
  const onStartScreen = doc === null
  useEffect(() => {
    if (!onStartScreen) return
    const query = window.api.getResumableSession?.()
    if (!query) return
    let alive = true
    query
      .then((session) => {
        if (alive) setResumable(session)
      })
      .catch(() => {
        if (alive) setResumable(null)
      })
    return () => {
      alive = false
    }
  }, [onStartScreen])

  if (doc) {
    return (
      <ProxyCanvas
        widthPx={doc.widthPx}
        heightPx={doc.heightPx}
        initialImages={doc.images}
        loadNonce={doc.nonce}
        projectFileName={doc.fileName}
        onProjectFileName={handleFileNameChange}
        onOpenProject={() => void openProjectFromDisk()}
        onNewProject={handleNewProject}
      />
    )
  }

  /** 규격 카드 — 실제 비율을 축소한 종이 아이콘으로 크기 감을 준다 */
  const sheetCard = (
    kind: SheetKind,
    label: string,
    caption: string,
    paper: { w: number; h: number }
  ): React.JSX.Element => {
    const active = sheetKind === kind
    return (
      <button
        key={kind}
        type="button"
        role="radio"
        aria-checked={active}
        onClick={() => setSheetKind(kind)}
        className={`flex flex-1 flex-col items-center gap-2 rounded-xl border px-2 py-3 transition-colors ${
          active
            ? 'border-indigo-500 bg-indigo-500/10 ring-1 ring-indigo-500'
            : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600 hover:bg-zinc-950'
        }`}
      >
        <span className="flex h-12 items-end justify-center">
          <span
            className={`block rounded-[3px] border-2 ${
              active ? 'border-indigo-500 bg-indigo-500/20' : 'border-zinc-600 bg-zinc-950'
            }`}
            style={{ width: paper.w, height: paper.h }}
          />
        </span>
        <span className={`text-sm font-semibold ${active ? 'text-indigo-300' : 'text-zinc-200'}`}>
          {label}
        </span>
        <span className="text-xs text-zinc-500">{caption}</span>
      </button>
    )
  }

  return (
    <main className="dtf-hero min-h-screen overflow-y-auto">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-white">
            <Layers size={19} strokeWidth={2} />
          </span>
          <span className="text-base font-bold tracking-tight text-zinc-100">
            DTF GangSheet Studio
          </span>
        </div>
        <ThemeToggle />
      </header>

      <div className="mx-auto grid max-w-6xl items-start gap-10 px-6 pb-14 pt-4 lg:grid-cols-[1.15fr_0.85fr] lg:pt-8">
        <section className="flex flex-col gap-6">
          <div className="flex flex-col gap-4">
            <span className="w-fit rounded-full border border-indigo-500/40 bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-300">
              350 DPI · 인쇄소 납품 규격
            </span>
            <h1 className="text-4xl font-extrabold leading-tight tracking-tight text-zinc-100 sm:text-5xl">
              여러 디자인을 한 장에,
              <br />
              <span className="text-indigo-400">갱시트</span>를 쉽고 빠르게
            </h1>
            <p className="max-w-xl text-base leading-relaxed text-zinc-400">
              이미지를 올리면 필름 위에 빈틈없이 배치하고, 인쇄소에 바로 보낼 수 있는 파일로
              저장합니다. 회원가입 없이 지금 바로 시작하세요.
            </p>
          </div>

          <img
            src={heroUrl}
            alt="디자인이 가득 배치된 DTF 필름 롤과 열프레스, 인쇄된 티셔츠"
            width={1200}
            height={900}
            className="dtf-card-shadow aspect-[16/10] w-full max-w-xl rounded-3xl border border-zinc-800 object-cover"
          />

          <ol className="grid max-w-xl gap-3 sm:grid-cols-3">
            {STEPS.map((step, index) => (
              <li
                key={step.title}
                className="flex flex-col gap-1.5 rounded-2xl border border-zinc-800 bg-zinc-900 p-4"
              >
                <span className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
                    {index + 1}
                  </span>
                  <step.icon size={16} strokeWidth={1.75} className="text-indigo-400" />
                </span>
                <span className="text-sm font-semibold text-zinc-100">{step.title}</span>
                <span className="text-xs leading-relaxed text-zinc-500">{step.body}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="flex flex-col gap-4 lg:sticky lg:top-6">
          {resumable && (
            <button
              type="button"
              onClick={() => void openProjectFromDisk(resumable.path)}
              className="dtf-card-shadow group flex items-center gap-3 rounded-2xl border border-indigo-500/50 bg-indigo-500/10 p-4 text-left transition-colors hover:bg-indigo-500/20"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white">
                <History size={19} strokeWidth={1.75} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-semibold text-zinc-100">이어서 작업하기</span>
                <span className="truncate text-xs text-zinc-400">
                  {formatSavedAt(resumable.savedAt)} 자동 저장 · 이미지 {resumable.imageCount}개 ·{' '}
                  {pxToCmLabel(resumable.widthPx)} × {pxToCmLabel(resumable.heightPx)} cm
                </span>
              </span>
              <ArrowRight
                size={18}
                strokeWidth={1.75}
                className="shrink-0 text-indigo-400 transition-transform group-hover:translate-x-0.5"
              />
            </button>
          )}

          <div className="dtf-card-shadow rounded-3xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-lg font-bold text-zinc-100">새 문서 만들기</h2>
            <p className="mt-1 text-sm text-zinc-500">인쇄할 필름 규격을 골라 주세요.</p>

            <div role="radiogroup" aria-label="문서 규격" className="mt-5 flex gap-2.5">
              {sheetCard('roll', '롤 (갱시트)', '폭 × 길이 선택', { w: 22, h: 44 })}
              {sheetCard('a4', 'A4', '21 × 29.7 cm', { w: 24, h: 34 })}
              {sheetCard('a3', 'A3', '29.7 × 42 cm', { w: 31, h: 44 })}
            </div>

            {!fixedPreset && (
              <>
                <div className="mt-5 flex flex-col gap-2">
                  <span className="text-sm font-semibold text-zinc-200">가로 폭</span>
                  <div className="flex flex-wrap items-center gap-2">
                    {QUICK_WIDTHS_CM.map((cm) => (
                      <button
                        key={cm}
                        type="button"
                        onClick={() => setWidthCm(cm)}
                        aria-pressed={widthCm === cm}
                        className={`rounded-lg border px-3 py-2 text-sm tabular-nums transition-colors ${
                          widthCm === cm
                            ? 'border-indigo-500 bg-indigo-500/10 font-semibold text-indigo-300'
                            : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-950'
                        }`}
                      >
                        {cm} cm
                      </button>
                    ))}
                    <div className="relative ml-auto flex items-center rounded-lg border border-zinc-800 bg-zinc-950 focus-within:ring-1 focus-within:ring-indigo-500">
                      <select
                        value={widthCm}
                        onChange={(e) => setWidthCm(Number(e.target.value))}
                        className="appearance-none bg-transparent py-2 pl-3 pr-8 text-sm tabular-nums text-zinc-200 outline-none"
                        aria-label="문서 가로 폭 (cm)"
                      >
                        {WIDTH_PRESETS_CM.map((cm) => (
                          <option key={cm} value={cm} className="bg-zinc-900">
                            {cm} cm
                          </option>
                        ))}
                      </select>
                      <ChevronDown
                        size={14}
                        strokeWidth={1.75}
                        className="pointer-events-none absolute right-2.5 text-zinc-500"
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex flex-col gap-2">
                  <span className="text-sm font-semibold text-zinc-200">세로 길이</span>
                  <div className="grid grid-cols-2 gap-2.5">
                    {HEIGHT_PRESETS_M.map((meters) => (
                      <label key={meters} className="cursor-pointer">
                        <input
                          type="radio"
                          name="height"
                          checked={heightM === meters}
                          onChange={() => setHeightM(meters)}
                          className="peer sr-only"
                        />
                        <div
                          className={`flex items-baseline justify-between rounded-lg border px-3.5 py-2.5 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 ${
                            heightM === meters
                              ? 'border-indigo-500 bg-indigo-500/10'
                              : 'border-zinc-800 bg-zinc-900 hover:bg-zinc-950'
                          }`}
                        >
                          <span
                            className={`text-base font-semibold tabular-nums ${
                              heightM === meters ? 'text-indigo-300' : 'text-zinc-200'
                            }`}
                          >
                            {meters} m
                          </span>
                          <span className="text-xs tabular-nums text-zinc-500">
                            {meters * 100} cm
                          </span>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="mt-5 flex items-center justify-between rounded-xl bg-zinc-950 px-4 py-3">
              <span className="text-sm text-zinc-500">만들 문서</span>
              <span className="flex flex-col items-end">
                <span className="text-sm font-semibold tabular-nums text-zinc-100">
                  {summaryCm}
                </span>
                <span className="text-xs tabular-nums text-zinc-500">
                  {widthPx.toLocaleString()} × {heightPx.toLocaleString()} px · 350 DPI
                </span>
              </span>
            </div>

            <button
              type="button"
              onClick={() => setDoc({ widthPx, heightPx, images: [], nonce: 1, fileName: null })}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-3.5 text-base font-semibold text-white transition-colors hover:bg-indigo-500 active:scale-[0.99]"
            >
              문서 만들기
              <ArrowRight size={18} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => void openProjectFromDisk()}
              className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 py-3 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-950 active:scale-[0.99]"
            >
              <FolderOpen size={16} strokeWidth={1.75} />
              프로젝트 열기
              <span className="text-zinc-500">(.dtf)</span>
            </button>
          </div>

          <p className="flex items-center gap-1.5 px-1 text-xs text-zinc-500">
            <ShieldCheck size={14} strokeWidth={1.75} className="shrink-0 text-emerald-400" />
            이미지는 서버로 전송되지 않고 내 컴퓨터 안에서만 처리됩니다.
          </p>
        </section>
      </div>
    </main>
  )
}

export default App
