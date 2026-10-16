import { useCallback, useSyncExternalStore } from 'react'

export type Theme = 'dark' | 'light'
const KEY = 'agentbus.theme'
let current: Theme = (() => {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'dark' || v === 'light') return v
  } catch {
    // ignore
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
})()
const listeners = new Set<() => void>()

function apply(t: Theme): void {
  document.documentElement.dataset.theme = t
}
apply(current)

export function setTheme(t: Theme): void {
  current = t
  try {
    localStorage.setItem(KEY, t)
  } catch {
    // ignore
  }
  apply(t)
  for (const fn of listeners) fn()
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => current,
    () => current,
  )
  const toggle = useCallback(() => setTheme(current === 'dark' ? 'light' : 'dark'), [])
  return { theme, toggle }
}
