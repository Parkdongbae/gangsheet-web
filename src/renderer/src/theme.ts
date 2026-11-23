import { useSyncExternalStore } from 'react'

/**
 * 화면 테마 — 기본은 밝은 테마. 선택값은 localStorage에 저장하고
 * <html data-theme>로 반영한다(색 정의는 assets/main.css).
 */
export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'dtf-theme'

function readStored(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

let current: Theme = readStored()
const listeners = new Set<() => void>()

function apply(): void {
  document.documentElement.dataset.theme = current
}
apply()

export function getTheme(): Theme {
  return current
}

export function setTheme(next: Theme): void {
  if (next === current) return
  current = next
  apply()
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* 저장 실패 시 이번 세션에만 적용 */
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 현재 테마 구독 — 캔버스처럼 CSS 변수로 칠할 수 없는 곳의 색 분기에 쓴다 */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme)
}
