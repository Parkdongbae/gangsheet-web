import { useEffect } from 'react'
import { Keyboard, X } from 'lucide-react'

interface ShortcutGroup {
  title: string
  rows: ReadonlyArray<readonly [keys: string, action: string]>
}

/** 편집기 조작법 — 예전 하단 힌트 줄의 내용을 주제별로 정리 */
const GROUPS: readonly ShortcutGroup[] = [
  {
    title: '화면 보기',
    rows: [
      ['마우스 휠', '확대 · 축소'],
      ['Space + 드래그', '화면 이동'],
      ['휠 클릭 + 드래그', '화면 이동']
    ]
  },
  {
    title: '선택 · 이동',
    rows: [
      ['드래그', '이동 (가장자리·다른 이미지에 자동 맞춤)'],
      ['Shift + 드래그', '가로·세로 한 방향으로만 이동'],
      ['빈 곳 드래그', '여러 개 한꺼번에 선택'],
      ['Ctrl + 클릭', '선택에 추가 · 제외'],
      ['방향키', '조금씩 이동 (Shift: 1mm)']
    ]
  },
  {
    title: '편집',
    rows: [
      ['Ctrl + 드래그', '끌어서 복제'],
      ['Ctrl + D', '복제'],
      ['Ctrl + C / X / V', '복사 / 잘라내기 / 붙여넣기'],
      ['R', '90° 회전'],
      ['Shift + 회전 핸들', '15° 단위로 회전'],
      ['Delete', '삭제']
    ]
  },
  {
    title: '정리 · 저장',
    rows: [
      ['Ctrl + G', '그룹으로 묶기'],
      ['Ctrl + L', '잠금 · 잠금 해제'],
      ['우클릭', '정렬 · 레이어 순서 · 잠금 메뉴'],
      ['Ctrl + Z / Y', '실행취소 / 다시실행'],
      ['Ctrl + S', '프로젝트 저장 (.dtf)']
    ]
  }
]

interface ShortcutsDialogProps {
  onClose: () => void
}

export function ShortcutsDialog({ onClose }: ShortcutsDialogProps): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="dtf-scrim fixed inset-0 z-10 flex items-center justify-center p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label="단축키와 조작법"
        className="dtf-card-shadow flex max-h-[88vh] w-full max-w-3xl flex-col rounded-2xl border border-zinc-800 bg-zinc-900"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-zinc-800 px-5 py-4">
          <Keyboard size={19} strokeWidth={1.75} className="text-indigo-400" />
          <h2 className="flex-1 text-base font-bold text-zinc-100">단축키와 조작법</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            <X size={17} strokeWidth={1.75} />
          </button>
        </div>
        <div className="grid gap-x-8 gap-y-6 overflow-y-auto p-5 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-2 text-sm font-semibold text-zinc-200">{group.title}</h3>
              <dl className="flex flex-col gap-1.5">
                {group.rows.map(([keys, action]) => (
                  <div key={keys} className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-xs font-medium text-zinc-300">
                      {keys}
                    </dt>
                    <dd className="text-right text-sm text-zinc-400">{action}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
