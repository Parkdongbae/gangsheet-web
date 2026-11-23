import { useEffect } from 'react'
import { ExternalLink, FileText, Globe } from 'lucide-react'

/** 무료 AI 배경 제거 웹 서비스 — target="_blank"는 setWindowOpenHandler가 시스템 브라우저로 라우팅 */
interface BgRemovalSite {
  name: string
  url: string
  /** DTF 인쇄 추천(원본 해상도 보존) 배지 */
  recommended?: boolean
  description: string
}

const BG_REMOVAL_SITES: readonly BgRemovalSite[] = [
  {
    name: 'Canva',
    url: 'https://www.canva.com/features/background-remover/',
    recommended: true,
    description:
      '사진을 올리고 "배경 제거"를 한 번 누르면 끝나는 가장 쉬운 방법입니다. 지운 뒤 같은 화면에서 글자·도형을 더해 디자인까지 마무리하고 투명 배경 PNG로 내려받을 수 있습니다.'
  },
  {
    name: 'Adobe Express',
    url: 'https://www.adobe.com/express/feature/image/remove-background/',
    recommended: true,
    description:
      '무료 아도비 계정만 로그인하면 원본 고해상도 그대로 무료 다운로드가 가능합니다. 포토샵 AI "피사체 선택" 엔진으로 경계선 추출 품질이 가장 정교합니다.'
  },
  {
    name: 'Erase.bg',
    url: 'https://www.erase.bg/',
    recommended: true,
    description:
      '복잡한 절차나 회원가입 없이 고화질 PNG 결과를 바로 받을 수 있습니다. 해상도 손실이 적고 작업 속도가 매우 빠릅니다.'
  },
  {
    name: 'Photoroom (웹 버전)',
    url: 'https://www.photoroom.com/background-remover',
    description:
      '제품·의류·인물 등 다양한 피사체 인식률이 월등히 뛰어납니다. 경계면의 유광/반사 처리까지 자연스럽게 누끼를 따줍니다.'
  },
  {
    name: 'Clipdrop (by Stability AI)',
    url: 'https://clipdrop.co/remove-background',
    description:
      '생성형 AI 전문 기업의 모델을 사용해 복잡한 윤곽선 감지 능력이 좋습니다. 디테일한 피사체를 깔끔하게 분리할 때 유용합니다.'
  }
]

interface BgSitesDialogProps {
  onClose: () => void
}

/** 배경 제거 사이트 모음 — 고해상도 다운로드가 가능한 무료 AI 누끼 서비스 링크 다이얼로그 */
export function BgSitesDialog({ onClose }: BgSitesDialogProps): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center dtf-scrim"
      onMouseDown={onClose}
    >
      <form
        className="flex max-h-[86vh] w-[460px] flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4 shadow-2xl"
        role="dialog"
        aria-label="배경 제거 사이트"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          onClose()
        }}
      >
        <div className="mb-3 flex items-center gap-2">
          <Globe size={16} strokeWidth={1.5} className="text-zinc-400" />
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold text-zinc-100">배경 제거 사이트</h2>
            <span className="text-[11px] text-zinc-500">
              앱의 배경 제거 결과가 아쉬울 때 쓸 수 있는 무료 사이트
            </span>
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
          {BG_REMOVAL_SITES.map((site) => (
            <a
              key={site.url}
              href={site.url}
              target="_blank"
              rel="noreferrer"
              className="group rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2.5 transition-colors hover:border-zinc-600 hover:bg-zinc-800"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-100">
                  {site.name}
                  {site.recommended && (
                    <span className="rounded border border-indigo-500/60 bg-indigo-500/15 px-1 py-px text-[10px] font-semibold text-indigo-300">
                      DTF 추천
                    </span>
                  )}
                </span>
                <ExternalLink
                  size={11}
                  strokeWidth={1.5}
                  className="shrink-0 text-zinc-600 transition-colors group-hover:text-zinc-300"
                />
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-zinc-400">
                {site.description}
              </span>
            </a>
          ))}

          <p className="mt-1 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-3 py-2.5 text-xs leading-relaxed text-zinc-300">
            받은 PNG를 캔버스에 끌어다 놓으면 됩니다. DTF 인쇄는 원본 크기가 중요하니, 내려받을 때
            해상도가 줄어들지 않았는지 확인하세요.
          </p>

          <button
            type="button"
            onClick={() => void window.api?.openGuidePdf()}
            title="번들된 가이드 PDF를 기본 뷰어로 엽니다"
            className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-[0.98]"
          >
            <FileText size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
            <span className="flex-1 text-left">포토샵 클라우드 가이드 (PDF)</span>
            <ExternalLink size={11} strokeWidth={1.5} className="shrink-0 text-zinc-600" />
          </button>

          <button
            type="button"
            onClick={() => void window.api?.openBgGuide()}
            title="번들된 Adobe Express 배경 제거 가이드 PDF를 기본 뷰어로 엽니다"
            className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 active:scale-[0.98]"
          >
            <FileText size={13} strokeWidth={1.5} className="shrink-0 text-zinc-400" />
            <span className="flex-1 text-left">Adobe Express 배경 제거 가이드 (PDF)</span>
            <ExternalLink size={11} strokeWidth={1.5} className="shrink-0 text-zinc-600" />
          </button>
        </div>

        <div className="mt-3 flex justify-end">
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
