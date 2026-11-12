import { useEffect, useState, useSyncExternalStore } from 'react'
import { useStore } from './store'
import { deviceClass } from './device'
import { withTransition } from './motion'
import { nativeSystemDark } from './native'
import { isEn, tr } from './i18n'
import { openFx, setOpenMs } from './bookfx'

const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

/**
 * 系统深浅色。安卓上 WebView 的 prefers-color-scheme 在应用后台期间切换夜间模式后常常不更新，
 * 所以优先直接问系统（原生桥），并在回到前台、系统通知时刷新。
 */
const readSystemDark = () => nativeSystemDark() ?? mq?.matches ?? false
let systemDark = typeof window !== 'undefined' ? readSystemDark() : false
const darkListeners = new Set<() => void>()
const setSystemDark = (v: boolean) => {
  if (v === systemDark) return
  systemDark = v
  darkListeners.forEach(l => l())
}
if (typeof window !== 'undefined') {
  mq?.addEventListener('change', () => setSystemDark(readSystemDark()))
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && setSystemDark(readSystemDark()))
  ;(window as unknown as { __readlySystemDark?: (d: boolean) => void }).__readlySystemDark = d => setSystemDark(!!d)
}

export function useSystemDark() {
  return useSyncExternalStore(
    cb => {
      darkListeners.add(cb)
      return () => darkListeners.delete(cb)
    },
    () => systemDark,
  )
}

export function useAppDark() {
  const theme = useStore(s => s.settings.appTheme)
  const sys = useSystemDark()
  return theme === 'dark' || (theme === 'system' && sys)
}

/** 电脑端且窗口足够宽：导航放到左侧、书架用更高密度 */
const sideMQ = typeof window !== 'undefined' ? window.matchMedia('(min-width: 760px)') : null
export function useDesktopLayout() {
  const [wide, setWide] = useState(sideMQ?.matches ?? false)
  useEffect(() => {
    if (!sideMQ) return
    const on = () => setWide(sideMQ.matches)
    sideMQ.addEventListener('change', on)
    return () => sideMQ.removeEventListener('change', on)
  }, [])
  return deviceClass === 'desktop' && wide
}

/** 打开阅读器时压入一条历史记录，安卓返回键即可退出阅读 */
export function enterReader(hash: string) {
  // 先在书架上量好封面的位置、启动“翻开封面”的动画，再切到阅读器
  setOpenMs(openFx(hash))
  history.pushState({ reader: hash }, '')
  useStore.getState().openReader(hash)
}
export function exitReader() {
  if (history.state?.reader) history.back()
  else useStore.getState().openReader(null)
}

/** 切换深浅色时整屏渐变 */
export function setAppTheme(theme: 'system' | 'light' | 'dark') {
  withTransition(() => useStore.getState().updateSettings(s => ({ ...s, appTheme: theme })))
}

/** 毫秒 → “3 小时 12 分” */
export function formatDuration(ms: number) {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return tr('不到 1 分钟')
  if (min < 60) return tr('{n} 分钟', { n: min })
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? tr('{h} 小时 {m} 分', { h, m }) : tr('{h} 小时', { h })
}

export function formatTime(ts?: number) {
  if (!ts) return tr('从未')
  const d = Date.now() - ts
  if (d < 60_000) return tr('刚刚')
  if (d < 3600_000) return tr('{n} 分钟前', { n: Math.floor(d / 60_000) })
  if (d < 86400_000) return tr('{n} 小时前', { n: Math.floor(d / 3600_000) })
  return new Date(ts).toLocaleDateString(isEn() ? 'en-US' : 'zh-CN')
}
