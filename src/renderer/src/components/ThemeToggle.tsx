import { Moon, Sun } from 'lucide-react'
import { setTheme, useTheme } from '../theme'

interface ThemeToggleProps {
  /** compact: 아이콘 한 개(편집기 상단), 기본: 밝게/어둡게 두 칸 선택(시작 화면) */
  compact?: boolean
}

export function ThemeToggle({ compact = false }: ThemeToggleProps): React.JSX.Element {
  const theme = useTheme()

  if (compact) {
    const next = theme === 'light' ? 'dark' : 'light'
    const label = next === 'dark' ? '어두운 화면으로 전환' : '밝은 화면으로 전환'
    return (
      <button
        type="button"
        onClick={() => setTheme(next)}
        title={label}
        aria-label={label}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
      >
        {theme === 'light' ? (
          <Moon size={17} strokeWidth={1.75} />
        ) : (
          <Sun size={17} strokeWidth={1.75} />
        )}
      </button>
    )
  }

  const option = (
    value: 'light' | 'dark',
    label: string,
    icon: React.ReactNode
  ): React.JSX.Element => (
    <button
      type="button"
      role="radio"
      aria-checked={theme === value}
      onClick={() => setTheme(value)}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
        theme === value
          ? 'bg-zinc-900 font-semibold text-zinc-100 shadow-sm'
          : 'text-zinc-500 hover:text-zinc-200'
      }`}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <div
      role="radiogroup"
      aria-label="화면 테마"
      className="flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-950 p-0.5"
    >
      {option('light', '밝게', <Sun size={15} strokeWidth={1.75} />)}
      {option('dark', '어둡게', <Moon size={15} strokeWidth={1.75} />)}
    </div>
  )
}
