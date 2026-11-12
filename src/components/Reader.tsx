import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import '../vendor/foliate-js/view.js'
import { beforeLeave, useStore } from '../lib/store'
import { openBook } from '../lib/book'
import { activeReaderTheme, bookCSS, DEFAULT_STATUS, readerTheme, type Behavior, type StatusConfig, type StatusItem, type StatusZone } from '../lib/settings'
import { exitReader, formatDuration } from '../lib/hooks'
import { fadeTransition } from '../lib/motion'
import Sheet, { type SheetPull } from './Sheet'
import { playTextFx, type TextFx } from '../lib/textfx'
import { guardDocument } from '../lib/appshell'
import { Overlayer } from '../vendor/foliate-js/overlayer.js'
import type { Annotation, HighlightColor } from '../lib/types'
import { emptySearch, HIGHLIGHT_COLORS, NoteDialog, NotesList, SearchSheet, SelectionMenu, type SearchState, type SelectionInfo } from './ReaderTools'
import { haptic, hasNativeBrightness, setImmersive, setKeepScreenOn, setNativeBrightness, setSystemBarsDark, setVolumeKeys, toggleFullscreen } from '../lib/native'
import { deviceClass } from '../lib/device'
import type { Progress } from '../lib/types'
import { AppearanceControls, BehaviorControls } from './ReadingControls'
import TocPanel, { type TocItem } from './TocPanel'
import { Segmented } from './ui'
import Presence from './Presence'
import {
  IconBack,
  IconBookmark,
  IconSearch,
  IconBookmarkFill,
  IconChevronL,
  IconChevronR,
  IconFullscreen,
  IconList,
  IconMoon,
  IconSettings,
  IconSun,
  IconTrash,
  IconType,
} from './icons'
import { tr } from '../lib/i18n'

interface Loc {
  fraction: number
  chapter: string
  tocHref: string
  cfi: string
  /** 本章当前页（从 1 开始）与总页数，不含分页器首尾的空白页 */
  page: number
  pages: number
  /** 当前在第几个章节文件（从 0 开始），用来换算“本章进度” */
  section: number
}

type Panel = null | 'toc' | 'style' | 'search'

/** 页眉、页脚各需要留出多高：没有内容时只留一点，字号越大留得越多 */
function statusRooms(b: Behavior): [number, number] {
  const s = b.status ?? DEFAULT_STATUS
  const on = (zones: StatusZone[]) => b.showStatusBar && Object.values(s).some(v => v.on && zones.includes(v.zone))
  const h = { sm: 26, md: 30, lg: 36 }[b.statusSize ?? 'md']
  return [on(['tl', 'tc', 'tr']) ? h : 8, on(['bl', 'bc', 'br']) ? h : 8]
}

/** 读取刘海/状态栏/手势条占用的安全区高度 */
function safeInsets() {
  const d = document.createElement('div')
  d.style.cssText =
    'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)'
  document.body.append(d)
  const cs = getComputedStyle(d)
  const out = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 }
  d.remove()
  return out
}

/* ---------- 位置的小型 store：翻页只刷新状态栏/进度条，不重渲染整个阅读器 ---------- */
function createLocStore() {
  let loc: Loc = { fraction: 0, chapter: '', tocHref: '', cfi: '', page: 0, pages: 0, section: 0 }
  const subs = new Set<() => void>()
  return {
    get: () => loc,
    set(next: Loc) {
      loc = next
      subs.forEach(f => f())
    },
    sub(f: () => void) {
      subs.add(f)
      return () => {
        subs.delete(f)
      }
    },
  }
}
type LocStore = ReturnType<typeof createLocStore>
const useLoc = (s: LocStore) => useSyncExternalStore(s.sub, s.get)

const Clock = memo(function Clock() {
  const fmt = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const [t, setT] = useState(fmt)
  useEffect(() => {
    const id = setInterval(() => setT(fmt()), 20_000)
    return () => clearInterval(id)
  }, [])
  return <span>{t}</span>
})

/** 电量（WebView2 与安卓 WebView 都支持 Battery API） */
function useBattery(enabled: boolean) {
  const [level, setLevel] = useState<{ pct: number; charging: boolean } | null>(null)
  useEffect(() => {
    if (!enabled || !(navigator as any).getBattery) return
    let bat: any
    const on = () => setLevel({ pct: Math.round(bat.level * 100), charging: bat.charging })
    ;(navigator as any).getBattery().then((b: any) => {
      bat = b
      on()
      b.addEventListener('levelchange', on)
      b.addEventListener('chargingchange', on)
    })
    return () => {
      bat?.removeEventListener('levelchange', on)
      bat?.removeEventListener('chargingchange', on)
    }
  }, [enabled])
  return level
}

const SessionTime = memo(function SessionTime({ start }: { start: number }) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force(x => x + 1), 30_000)
    return () => clearInterval(id)
  }, [])
  return <span>{tr('本次 {time}', { time: formatDuration(Date.now() - start) })}</span>
})

const ZONES: StatusZone[] = ['tl', 'tc', 'tr', 'bl', 'bc', 'br']
/** 每个区域里各项的显示顺序 */
const ITEM_ORDER: Exclude<StatusItem, 'none'>[] = ['clock', 'battery', 'title', 'chapter', 'chapterPage', 'chapterLeft', 'progress', 'sessionTime']

const StatusOverlay = memo(function StatusOverlay({
  store,
  title,
  color,
  status,
  size,
  sessionStart,
}: {
  store: LocStore
  title: string
  color: string
  status: StatusConfig
  size: 'sm' | 'md' | 'lg'
  sessionStart: number
}) {
  const loc = useLoc(store)
  const battery = useBattery(status.battery.on)
  const render = (item: StatusItem) => {
    switch (item) {
      case 'chapter':
        return <span key={item}>{loc.chapter || title}</span>
      case 'title':
        return <span key={item}>{title}</span>
      case 'clock':
        return <Clock key={item} />
      case 'progress':
        return <span key={item}>{(loc.fraction * 100).toFixed(1)}%</span>
      case 'chapterPage':
        return loc.pages ? <span key={item}>{tr('本章 {page}/{pages}', { page: loc.page, pages: loc.pages })}</span> : null
      case 'chapterLeft':
        return loc.pages ? <span key={item}>{loc.pages - loc.page > 0 ? tr('本章剩 {n} 页', { n: loc.pages - loc.page }) : tr('本章最后一页')}</span> : null
      case 'battery':
        return battery ? <span key={item}>{battery.charging ? '⚡' : ''}{battery.pct}%</span> : null
      case 'sessionTime':
        return <SessionTime key={item} start={sessionStart} />
      default:
        return null
    }
  }
  const byZone = (z: StatusZone) => ITEM_ORDER.filter(i => status[i].on && status[i].zone === z)
  const row = (zones: StatusZone[], cls: string) =>
    zones.some(z => byZone(z).length) ? (
      <div className={`${cls} status-${size}`} style={{ color }}>
        {zones.map(z => (
          <div key={z} className={`status-zone zone-${z[1]}`}>
            {byZone(z).map(render)}
          </div>
        ))}
      </div>
    ) : null
  return (
    <>
      {row(ZONES.slice(0, 3), 'reader-top-status')}
      {row(ZONES.slice(3), 'reader-status')}
    </>
  )
})

const BookmarkButton = memo(function BookmarkButton({ store, hash, title, viewRef }: { store: LocStore; hash: string; title: string; viewRef: React.RefObject<any> }) {
  const loc = useLoc(store)
  const bookmarks = useStore(s => s.library.find(b => b.hash === hash)?.bookmarks)
  const mark = bookmarks?.find(b => !b.deleted && b.cfi === loc.cfi)
  const toggle = () => {
    const st = useStore.getState()
    if (mark) return st.removeBookmark(hash, mark.id)
    const range: Range | undefined = viewRef.current?.lastLocation?.range
    const text = range?.toString().replace(/\s+/g, ' ').trim().slice(0, 80) ?? ''
    st.addBookmark(hash, { cfi: loc.cfi, label: loc.chapter || title, text, fraction: loc.fraction })
    st.showToast(tr('已添加书签'))
  }
  return (
    <button className={`icon-btn ${mark ? 'on pop' : ''}`} aria-label={tr('书签')} onClick={toggle}>
      {mark ? <IconBookmarkFill /> : <IconBookmark />}
    </button>
  )
})

/**
 * 工具栏的章节行：两侧按钮切上一章/下一章；中间的章节名可以左右滑动切换章节（往左滑下一章）。
 * 全书进度滑块默认不显示（容易误触），可以在“翻页与操作”里打开。
 */
const ProgressBar = memo(function ProgressBar({
  store,
  viewRef,
  slider,
  mode,
  onMode,
}: {
  store: LocStore
  viewRef: React.RefObject<any>
  slider: boolean
  /** 滑块拖的是全书进度还是本章进度 */
  mode: 'book' | 'chapter'
  onMode: (m: 'book' | 'chapter') => void
}) {
  const loc = useLoc(store)
  const [drag, setDrag] = useState<number | null>(null)
  // 本章在全书里的起止位置（引擎按各章节的字数算的）
  const fr: number[] = (slider && mode === 'chapter' && viewRef.current?.getSectionFractions?.()) || []
  const lo = fr[loc.section] ?? 0
  const hi = fr[loc.section + 1] ?? 1
  const chapterMode = slider && mode === 'chapter' && fr.length > 1 && hi > lo
  const value = chapterMode ? Math.min(1, Math.max(0, (loc.fraction - lo) / (hi - lo))) : loc.fraction
  const commit = () => {
    // 本章模式：换算回全书位置；乘 0.9995 是为了拖到头时停在本章最后，而不是跳进下一章
    if (drag !== null) viewRef.current?.goToFraction(chapterMode ? lo + drag * (hi - lo) * 0.9995 : drag)
    setDrag(null)
  }
  // 换了章节或换了模式：丢掉拖到一半的值
  useEffect(() => setDrag(null), [loc.section, mode])
  const pct = ((drag !== null && !chapterMode ? drag : loc.fraction) * 100).toFixed(1)

  const labelRef = useRef<HTMLSpanElement>(null)
  /** 刚刚往哪个方向切了章节：新章节名从那一侧滑进来 */
  const enterFrom = useRef(0)
  const enterTimer = useRef<ReturnType<typeof setTimeout>>()
  const go = (dir: 1 | -1) => {
    haptic(8)
    enterFrom.current = dir
    clearTimeout(enterTimer.current)
    enterTimer.current = setTimeout(() => (enterFrom.current = 0), 900)
    const r = viewRef.current?.renderer
    if (dir > 0) r?.nextSection?.()
    else r?.prevSection?.()
  }
  useEffect(() => () => clearTimeout(enterTimer.current), [])
  useLayoutEffect(() => {
    const el = labelRef.current
    const dir = enterFrom.current
    if (!el || !dir) return
    enterFrom.current = 0
    if (document.documentElement.dataset.motion === 'off') return
    el.animate?.(
      [
        { transform: `translate3d(${dir * 36}px, 0, 0)`, opacity: 0 },
        { transform: 'translate3d(0, 0, 0)', opacity: 1 },
      ],
      { duration: 280, easing: 'cubic-bezier(.2, .8, .2, 1)' },
    )
  }, [loc.chapter])

  const swipe = useRef<{ x: number; id: number } | null>(null)
  const follow = (dx: number, animate: boolean) => {
    const el = labelRef.current
    if (!el) return
    el.style.transition = animate ? 'transform .22s cubic-bezier(.2, .8, .2, 1), opacity .22s' : 'none'
    el.style.transform = dx ? `translate3d(${dx * 0.7}px, 0, 0)` : ''
    el.style.opacity = dx ? String(Math.max(0.25, 1 - Math.abs(dx) / 140)) : ''
  }
  return (
    <>
      <div className="bar-row">
        <button className="icon-btn" aria-label={tr('上一章')} onClick={() => go(-1)}>
          <IconChevronL />
        </button>
        <div
          className="chapter-swipe"
          title={tr('左右滑动切换章节')}
          onPointerDown={e => {
            if (e.button !== 0) return
            try {
              e.currentTarget.setPointerCapture(e.pointerId)
            } catch {
              /* 个别环境不支持捕获 */
            }
            swipe.current = { x: e.clientX, id: e.pointerId }
          }}
          onPointerMove={e => {
            const s = swipe.current
            if (s && s.id === e.pointerId) follow(e.clientX - s.x, false)
          }}
          onPointerUp={e => {
            const s = swipe.current
            swipe.current = null
            if (!s) return
            const dx = e.clientX - s.x
            follow(0, true)
            if (Math.abs(dx) > 44) go(dx < 0 ? 1 : -1)
          }}
          onPointerCancel={() => {
            swipe.current = null
            follow(0, true)
          }}
        >
          <span className="chapter" ref={labelRef}>
            {loc.chapter || '—'}
          </span>
        </div>
        <span className="pct">{pct}%</span>
        <button className="icon-btn" aria-label={tr('下一章')} onClick={() => go(1)}>
          <IconChevronR />
        </button>
      </div>
      {slider && (
        <div className="bar-slider">
          <button
            className="slider-mode"
            title={tr('切换：拖动全书进度 / 本章进度')}
            aria-label={tr('切换：拖动全书进度 / 本章进度')}
            onClick={() => onMode(mode === 'chapter' ? 'book' : 'chapter')}
          >
            {chapterMode ? tr('本章') : tr('全书')}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.0005}
            value={drag ?? value}
            onChange={e => setDrag(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            aria-label={chapterMode ? tr('本章进度') : tr('全书进度')}
          />
          <span className="slider-pct">{Math.round((drag ?? value) * 100)}%</span>
        </div>
      )}
    </>
  )
})

/**
 * 目录按钮：点一下打开目录；长按（或按住直接往右拖）时，目录跟着手指从左边被拉出来，松手决定开还是收。
 *
 * 点按用系统的 click 事件打开，而不是在手指抬起时打开：手机上 click 是在抬起之后、按“当时手指下面是什么”
 * 才派发的，如果抬起时就把目录和半透明遮罩放出来，这个 click 会落在刚出现的遮罩上，把目录立刻又关掉。
 */
function TocButton({ onOpen, onPull }: { onOpen: () => void; onPull: (p: SheetPull) => void }) {
  const st = useRef<{ x: number; y: number; id: number; pulled: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  /** 刚刚拉出过目录：紧跟着的那次 click 不算点按 */
  const pulledAt = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const pull = () => {
    const s = st.current
    if (!s || s.pulled) return
    s.pulled = true
    pulledAt.current = Date.now()
    clearTimeout(timer.current)
    haptic(12)
    onPull({ x: s.x, id: s.id })
  }
  return (
    <button
      className="icon-btn toc-btn"
      aria-label={tr('目录')}
      title={tr('点按打开目录；按住往右拖可以把目录拉出来')}
      onClick={() => {
        if (Date.now() - pulledAt.current < 800) return
        onOpen()
      }}
      onContextMenu={e => e.preventDefault()}
      onPointerDown={e => {
        if (e.button !== 0) return
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* 个别环境不支持捕获 */
        }
        st.current = { x: e.clientX, y: e.clientY, id: e.pointerId, pulled: false }
        clearTimeout(timer.current)
        timer.current = setTimeout(pull, 300)
      }}
      onPointerMove={e => {
        const s = st.current
        if (!s || s.pulled || s.id !== e.pointerId) return
        const dx = e.clientX - s.x
        // 按住直接往右拖：不用等长按，立刻开始拉
        if (dx > 10 && dx > Math.abs(e.clientY - s.y)) pull()
      }}
      onPointerUp={() => {
        clearTimeout(timer.current)
        st.current = null
      }}
      onPointerCancel={() => {
        clearTimeout(timer.current)
        st.current = null
      }}
    >
      <IconList />
    </button>
  )
}

/** 亮度值 → 遮罩的不透明度（没有原生亮度接口的平台只能调暗） */
const dimOpacity = (b: number) => (b < 0 ? 0 : Math.min(0.86, (1 - b) * 0.88))

/**
 * 日间/夜间背景切换按钮：点一下切换；长按（或按住直接拖）后左右滑动调节屏幕亮度。
 * 拖动过程中只更新本地显示和实际亮度，松手时才写入设置。
 */
function ThemeButton({ dark, brightness, onToggle, onPreview, onCommit }: { dark: boolean; brightness: number; onToggle: () => void; onPreview: (v: number | null) => void; onCommit: (v: number) => void }) {
  const st = useRef<{ x: number; id: number; base: number; mode: 'wait' | 'bright'; value: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const [hud, setHud] = useState<number | null>(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const begin = () => {
    const s = st.current
    if (!s || s.mode === 'bright') return
    s.mode = 'bright'
    haptic(12)
    setHud(s.value)
    onPreview(s.value)
  }
  const finish = (commit: boolean) => {
    clearTimeout(timer.current)
    const s = st.current
    st.current = null
    if (!s) return
    if (s.mode === 'bright') {
      setHud(null)
      onPreview(null)
      // 只长按没滑动：不改亮度
      if (commit && s.value !== s.base) onCommit(s.value)
    } else if (commit) onToggle()
  }
  return (
    <>
      <button
        className="icon-btn theme-btn"
        aria-label={dark ? tr('切换到日间背景') : tr('切换到夜间背景')}
        title={tr('点按切换日间/夜间背景；长按后左右滑动调节亮度')}
        // 鼠标/触摸由指针事件处理；这里只响应键盘（detail 为 0）
        onClick={e => e.detail === 0 && onToggle()}
        onContextMenu={e => e.preventDefault()}
        onPointerDown={e => {
          if (e.button !== 0) return
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* 个别环境不支持捕获 */
          }
          // 还在“跟随系统”时不知道系统亮度是多少：原生亮度从中间开始，遮罩从全亮开始
          const base = brightness >= 0 ? brightness : hasNativeBrightness() ? 0.5 : 1
          st.current = { x: e.clientX, id: e.pointerId, base, mode: 'wait', value: base }
          clearTimeout(timer.current)
          timer.current = setTimeout(begin, 320)
        }}
        onPointerMove={e => {
          const s = st.current
          if (!s || s.id !== e.pointerId) return
          const dx = e.clientX - s.x
          if (s.mode === 'wait') {
            if (Math.abs(dx) < 12) return
            clearTimeout(timer.current)
            begin()
          }
          s.value = Math.min(1, Math.max(0.02, s.base + dx / 240))
          setHud(s.value)
          onPreview(s.value)
        }}
        onPointerUp={() => finish(true)}
        onPointerCancel={() => finish(false)}
      >
        {dark ? <IconSun /> : <IconMoon />}
      </button>
      {hud !== null && (
        <div className="bright-hud glass" role="status">
          <IconSun />
          <div className="bright-track">
            <i style={{ width: `${hud * 100}%` }} />
          </div>
          <span>{Math.round(hud * 100)}%</span>
        </div>
      )}
    </>
  )
}

function TocSheet({
  hash,
  store,
  toc,
  onGo,
  tab,
  setTab,
  onEditNote,
  onClose,
  pull,
}: {
  hash: string
  store: LocStore
  toc: TocItem[]
  onGo: (t: string) => void
  tab: TocTab
  setTab: (t: TocTab) => void
  onEditNote: (a: Annotation) => void
  onClose: () => void
  pull?: SheetPull | null
}) {
  const loc = useLoc(store)
  const rec = useStore(s => s.library.find(b => b.hash === hash))
  const marks = (rec?.bookmarks ?? []).filter(b => !b.deleted)
  const notes = (rec?.annotations ?? []).filter(a => !a.deleted)
  const totalMs = Object.values(rec?.readStats ?? {}).reduce((a, s) => a + s.ms, 0)
  return (
    <Sheet side onClose={onClose} pull={pull}>
      <div className="toc-head">
        <div className="serif toc-title">{rec?.title}</div>
        <div className="toc-sub">{tr('已读 {time}', { time: formatDuration(totalMs) })}</div>
      </div>
      <div className="tabs">
        <Segmented
          value={tab}
          options={[
            ['toc', tr('目录')],
            ['marks', `${tr('书签')} ${marks.length || ''}`],
            ['notes', `${tr('笔记')} ${notes.length || ''}`],
          ]}
          onChange={setTab}
        />
      </div>
      {tab === 'notes' ? (
        <NotesList hash={hash} onGo={onGo} onEdit={onEditNote} />
      ) : tab === 'toc' ? (
        toc.length ? (
          <TocPanel toc={toc} current={loc.tocHref} fraction={loc.fraction} onGo={onGo} />
        ) : (
          <p style={{ color: 'var(--muted)' }}>{tr('这本书没有目录')}</p>
        )
      ) : marks.length ? (
        <div className="toc-list">
          {marks.map(m => (
            <div key={m.id} className="bm-item">
              <button className="go" onClick={() => onGo(m.cfi)}>
                <b>{m.label}</b>
                <span>
                  {(m.fraction * 100).toFixed(1)}% · {m.text || tr('（无摘录）')}
                </span>
              </button>
              <button className="icon-btn" aria-label={tr('删除书签')} onClick={() => useStore.getState().removeBookmark(hash, m.id)}>
                <IconTrash />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ color: 'var(--muted)' }}>{tr('点击顶部的书签按钮，记下当前页')}</p>
      )}
    </Sheet>
  )
}

type TocTab = 'toc' | 'marks' | 'notes'

export default function Reader({ hash, closing = false }: { hash: string; closing?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<any>(null)
  const formatRef = useRef<'epub' | 'txt'>('epub')
  const locStore = useRef<LocStore>(null as unknown as LocStore)
  if (!locStore.current) locStore.current = createLocStore()

  const [status, setStatus] = useState<'syncing' | 'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [chrome, setChrome] = useState(false)
  const [panel, setPanelState] = useState<Panel>(null)
  const [tocTab, setTocTab] = useState<TocTab>('toc')
  const [search, setSearch] = useState<SearchState>(emptySearch)
  /** 当前选中的文字（或点到的已有高亮），显示划词菜单 */
  const [sel, setSel] = useState<SelectionInfo | null>(null)
  const selRef = useRef<SelectionInfo | null>(null)
  selRef.current = sel
  /** 正在编辑笔记的位置 */
  const [noteFor, setNoteFor] = useState<SelectionInfo | null>(null)
  /** 刚点中一个高亮：这次点击不再翻页/呼出菜单 */
  const annoTap = useRef(0)
  const panelRef = useRef<Panel>(null)
  panelRef.current = panel
  /**
   * 打开面板（目录、外观、翻页设置）时压入一条历史记录：安卓返回键先关面板，再按一次才退出书籍。
   * 用手关闭面板时也回退这条记录，保持历史栈干净。
   */
  const setPanel = useCallback(
    (p: Panel) => {
      const open = panelRef.current
      if (p && !open) history.pushState({ reader: hash, panel: p }, '')
      else if (p && open) history.replaceState({ reader: hash, panel: p }, '')
      else if (!p && open && history.state?.panel) return history.back() // popstate 里再真正关闭
      setPanelState(p)
    },
    [hash],
  )
  useEffect(() => {
    const onPop = () => {
      if (!history.state?.panel) setPanelState(null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const [styleTab, setStyleTab] = useState<'look' | 'behavior'>('look')
  const [toc, setToc] = useState<TocItem[]>([])
  /** 长按目录按钮往右拖：目录跟着手指被拉出来 */
  const [tocPull, setTocPull] = useState<SheetPull | null>(null)
  /** 打开书时的文字特效（浮现 / 符文）：播放期间书页先藏着，特效结束再交接 */
  const [textFx] = useState<TextFx | null>(() => {
    const a = useStore.getState().settings.bookAnim
    return (a === 'emerge' || a === 'runes') && document.documentElement.dataset.motion !== 'off' ? a : null
  })
  const [fxHold, setFxHold] = useState(!!textFx)
  const fxLayer = useRef<HTMLDivElement>(null)

  const title = useStore(s => s.library.find(b => b.hash === hash)?.title ?? '')
  const localOnly = useStore(s => s.library.find(b => b.hash === hash)?.localOnly)
  const reading = useStore(s => s.settings.reading)
  const behavior = useStore(s => s.settings.behavior)
  const customFonts = useStore(s => s.customFonts)
  const theme = activeReaderTheme(reading)
  // 阅读时系统栏跟随阅读背景；开始合上书的那一刻就还原为界面的深浅色（不等退场动画播完）
  useEffect(() => {
    setSystemBarsDark(closing ? document.documentElement.dataset.theme === 'dark' : theme.dark)
  }, [theme.dark, closing])
  useEffect(() => () => setSystemBarsDark(document.documentElement.dataset.theme === 'dark'), [])
  // 阅读时保持屏幕常亮
  const keepAwake = useStore(s => s.settings.keepAwake)
  useEffect(() => {
    if (!keepAwake || closing) return
    setKeepScreenOn(true)
    return () => setKeepScreenOn(false)
  }, [keepAwake, closing])
  // 屏幕亮度：安卓直接调窗口亮度；其他平台盖一层遮罩调暗。preview 是正在拖动调节时的临时值
  const [brightPreview, setBrightPreview] = useState<number | null>(null)
  const brightness = brightPreview ?? reading.brightness ?? -1
  const nativeBright = hasNativeBrightness()
  useEffect(() => {
    if (!nativeBright || closing) return
    setNativeBrightness(brightness)
    return () => setNativeBrightness(-1)
  }, [nativeBright, brightness, closing])

  /* 事件处理器读取最新状态，不触发重渲染 */
  const live = useRef({ chrome, panel, behavior, closing })
  live.current = { chrome, panel, behavior, closing }
  const progressRef = useRef<Progress | null>(null)
  const savedCfi = useRef<string | undefined>(undefined)
  /** 本机最近一次写入进度的时间，用来判断云端进度是否更新 */
  const localProgressAt = useRef(0)
  /** 云端有更新的进度时，不再自动跳转，只给一个“跳过去”的提示，由你决定 */
  const [offer, setOffer] = useState<Progress | null>(null)
  const offerFor = useRef<string | undefined>(undefined)
  const proposeRemote = (p: Progress) => {
    if (offerFor.current === p.cfi) return
    offerFor.current = p.cfi
    setOffer(p)
  }
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const syncTimer = useRef<ReturnType<typeof setTimeout>>()

  /* ---------- 阅读计时：有操作的 3 分钟内算作在读 ---------- */
  const sessionStart = useRef(Date.now())
  const lastActive = useRef(Date.now())
  const lastTick = useRef(Date.now())
  const tick = useCallback(() => {
    const now = Date.now()
    const dt = Math.min(now - lastTick.current, 60_000)
    lastTick.current = now
    if (status !== 'ready' && status !== 'loading') return
    if (document.visibilityState === 'visible' && now - lastActive.current < 180_000 && dt > 0)
      useStore.getState().addReadingTime(hash, dt)
  }, [hash, status])
  const touch = () => (lastActive.current = Date.now())

  const flushProgress = useCallback(() => {
    clearTimeout(saveTimer.current)
    if (!progressRef.current) return
    useStore.getState().saveProgress(hash, progressRef.current)
    savedCfi.current = progressRef.current.cfi
    localProgressAt.current = progressRef.current.updatedAt
    progressRef.current = null
  }, [hash])

  // 合上书、切到后台、关窗口之前：立刻结算阅读时长并保存当前进度（由 store 统一调用）
  useEffect(() => {
    const fn = () => {
      tick()
      flushProgress()
    }
    beforeLeave.add(fn)
    return () => void beforeLeave.delete(fn)
  }, [tick, flushProgress])

  /* ---------- 翻页与交互 ---------- */
  const turn = useCallback((dir: 'prev' | 'next' | 'left' | 'right') => {
    const v = viewRef.current
    if (!v) return
    touch()
    if (dir === 'prev') v.prev()
    else if (dir === 'next') v.next()
    else if (dir === 'left') v.goLeft()
    else v.goRight()
  }, [])

  const handleTap = useCallback(
    (x: number) => {
      touch()
      if (Date.now() - annoTap.current < 400) return
      if (selRef.current) {
        viewRef.current?.deselect?.()
        return setSel(null)
      }
      const { chrome, panel, behavior } = live.current
      if (panel) return setPanel(null)
      if (chrome) return setChrome(false)
      const w = innerWidth
      const zone = x < w * 0.3 ? 'left' : x > w * 0.7 ? 'right' : 'center'
      if (zone === 'center' || !behavior.tapToTurn) return setChrome(true)
      if (behavior.tapMode === 'next') turn('next')
      else turn(zone)
    },
    [turn],
  )

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const { chrome, panel, behavior, closing } = live.current
      if (closing) return // 正在合上书：不再响应按键
      const typing = t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA'
      if (e.key === 'Escape') {
        // Esc：依次关闭划词菜单 → 面板 → 工具栏，最后退出书籍
        if (noteRef.current) return
        if (selRef.current) {
          viewRef.current?.deselect?.()
          setSel(null)
        } else if (panel) setPanel(null)
        else if (chrome) setChrome(false)
        else exitReader()
        e.preventDefault()
        return
      }
      if (typing) return
      const k = e.key.toLowerCase()
      const mod = e.ctrlKey || e.metaKey
      // 电脑快捷键：打开阅读页的各个二级菜单
      const shortcut: Record<string, () => void> = {
        t: () => (setTocTab('toc'), setPanel('toc')),
        n: () => (setTocTab('notes'), setPanel('toc')),
        f: () => setPanel('search'),
        a: () => (setStyleTab('look'), setPanel('style')),
        o: () => (setStyleTab('behavior'), setPanel('style')),
        b: () => toggleBookmarkRef.current(),
        d: () => toggleDarkRef.current(),
        m: () => setChrome(c => !c),
      }
      if (mod && k === 'f') return e.preventDefault(), shortcut.f()
      if (mod && k === 'd') return e.preventDefault(), shortcut.b()
      if (!mod && !e.altKey && shortcut[k]) return e.preventDefault(), shortcut[k]()
      if (e.key === 'Enter' && !panel) return e.preventDefault(), setChrome(c => !c)
      switch (e.key) {
        case 'ArrowLeft':
          turn('left')
          break
        case 'ArrowRight':
          turn('right')
          break
        case 'ArrowUp':
        case 'PageUp':
          if (behavior.flow === 'paginated') turn('prev')
          else return
          break
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
          if (behavior.flow === 'paginated') turn('next')
          else return
          break
        default:
          return
      }
      e.preventDefault()
    },
    [turn],
  )

  const lastWheel = useRef(0)
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      touch()
      const { behavior, panel } = live.current
      if (panel || behavior.flow !== 'paginated' || !behavior.wheelTurn) return
      const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (Math.abs(d) < 4) return
      const now = Date.now()
      if (now - lastWheel.current < 280) return
      lastWheel.current = now
      turn(d > 0 ? 'next' : 'prev')
    },
    [turn],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  /* ---------- 安卓音量键翻页（设置里开启；离开阅读页立刻恢复调节音量） ---------- */
  useEffect(() => {
    if (!behavior.volumeKeys || status !== 'ready' || closing) return
    const w = window as unknown as { __readlyVolumeKey?: (d: string) => void }
    w.__readlyVolumeKey = d => {
      if (live.current.panel) return
      turn(d === 'next' ? 'next' : 'prev')
    }
    setVolumeKeys(true)
    return () => {
      setVolumeKeys(false)
      delete w.__readlyVolumeKey
    }
  }, [behavior.volumeKeys, status, turn, closing])

  /* ---------- 安卓沉浸模式 ---------- */
  useEffect(() => {
    if (!behavior.immersive || closing) return
    setImmersive(true)
    return () => setImmersive(false)
  }, [behavior.immersive, closing])

  /* ---------- 打开书籍 ---------- */
  useEffect(() => {
    let cancelled = false
    let view: any = null
    let book: any = null
    const st = useStore.getState()
    let pendingLoc: Loc | null = null
    let raf = 0
    let secFrac = 0
    let secSize = 0
    const behaviorFlow = () => useStore.getState().settings.behavior.flow

    const onDocLoad = (e: CustomEvent) => {
      const doc: Document = e.detail.doc
      const index: number = e.detail.index
      guardDocument(doc) // 书页里也不弹浏览器右键菜单、不响应刷新等快捷键
      doc.addEventListener('click', ev => {
        if (ev.defaultPrevented || (ev.target as Element)?.closest?.('a[href]')) return
        const s = doc.getSelection()
        if (s && !s.isCollapsed) return
        const frame = doc.defaultView?.frameElement as HTMLElement | null
        const left = frame?.getBoundingClientRect().left ?? 0
        const x = left + ev.clientX
        // 高亮的点击由渲染引擎在同一次点击里处理，等它先判定是否点中了高亮
        setTimeout(() => handleTap(x), 0)
      })
      // 划词：选区稳定后弹出高亮/笔记菜单（安卓拖动选区手柄时会持续触发 selectionchange）
      let selTimer: ReturnType<typeof setTimeout> | undefined
      const checkSel = () => {
        const s = doc.getSelection()
        if (!s || s.isCollapsed || !s.rangeCount) return
        const range = s.getRangeAt(0)
        const text = range.toString().replace(/\s+/g, ' ').trim()
        if (!text) return
        let cfi = ''
        try {
          cfi = viewRef.current?.getCFI(index, range)
        } catch {
          return
        }
        if (!cfi) return
        const frame = doc.defaultView?.frameElement as HTMLElement | null
        const fr = frame?.getBoundingClientRect() ?? { left: 0, top: 0 }
        const r = range.getBoundingClientRect()
        // 章节与位置按选区本身计算（预加载的相邻章节里也能划词，不能用当前阅读位置）
        const v = viewRef.current
        const l = locStore.current.get()
        let chapter = l.chapter
        let fraction = l.fraction
        try {
          chapter = v?.getProgressOf(index, range)?.tocItem?.label?.trim() || chapter
          const fr2: number[] = v?.getSectionFractions?.() ?? []
          if (fr2.length > index) fraction = fr2[index] + ((fr2[index + 1] ?? 1) - fr2[index]) * 0.001
        } catch {
          /* 取不到就用当前位置 */
        }
        setSel({
          cfi,
          text: text.slice(0, 2000),
          fraction,
          chapter,
          rect: { left: fr.left + r.left, top: fr.top + r.top, bottom: fr.top + r.bottom, width: r.width },
        })
      }
      doc.addEventListener('pointerup', () => setTimeout(checkSel, 20))
      doc.addEventListener('selectionchange', () => {
        clearTimeout(selTimer)
        selTimer = setTimeout(checkSel, 450)
      })
      doc.addEventListener('keydown', handleKey)
      doc.addEventListener('wheel', handleWheel, { passive: true })
      doc.addEventListener('touchstart', touch, { passive: true })
      doc.addEventListener('scroll', touch, { passive: true })
    }

    const onRelocate = (e: CustomEvent) => {
      const { fraction, tocItem, cfi } = e.detail
      touch()
      // 每帧最多更新一次 UI，滑动翻页时不会堆积渲染
      // 本章页码：分页器报告本章内的位置 secFrac 与每页占比 secSize（新版引擎会把相邻章节连着排版）
      const pages = secSize > 0 && behaviorFlow() === 'paginated' ? Math.max(1, Math.round(1 / secSize)) : 0
      const page = pages ? Math.min(pages, Math.floor(secFrac * pages + 1e-4) + 1) : 0
      pendingLoc = { fraction: fraction ?? 0, chapter: tocItem?.label?.trim() ?? '', tocHref: tocItem?.href ?? '', cfi, page, pages, section: Number(e.detail.section?.current) || 0 }
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          if (pendingLoc) locStore.current.set(pendingLoc)
        })
      if (!cfi || cfi === savedCfi.current) return
      progressRef.current = { cfi, fraction: fraction ?? 0, chapter: tocItem?.label?.trim(), updatedAt: Date.now() }
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(flushProgress, 1000)
      clearTimeout(syncTimer.current)
      // 停在一页 20 秒后把进度传上去：即使之后应用被系统直接杀掉，云端也只差最后这一小段
      syncTimer.current = setTimeout(() => useStore.getState().syncQuick('push'), 20_000)
    }

    ;(async () => {
      try {
        let rec = st.library.find(b => b.hash === hash)
        if (!rec) throw new Error(tr('书架上找不到这本书'))
        const before = rec.progress
        // 拉取其他设备进度与打开书并行进行，不再干等网络
        let pullDone = false
        const pull =
          st.settings.behavior.syncOnOpen && !rec.localOnly && st.sync.enabled
            ? st.syncQuick('pull', 8000).finally(() => (pullDone = true))
            : null
        const bytes = await st.loadBookFile(rec)
        if (cancelled) return
        formatRef.current = rec.format
        book = await openBook(rec.format, bytes, rec.fileName)
        if (cancelled) return book.destroy?.()
        view = document.createElement('foliate-view')
        viewRef.current = view
        view.addEventListener('load', onDocLoad)
        view.addEventListener('relocate', onRelocate)
        // 高亮：渲染引擎请求绘制时用对应颜色画；新的章节渲染出来时把这本书的高亮都补上
        view.addEventListener('draw-annotation', (ev: CustomEvent) => {
          const { draw, annotation } = ev.detail
          draw(Overlayer.highlight, { color: HIGHLIGHT_COLORS[annotation.color as HighlightColor] ?? HIGHLIGHT_COLORS.yellow })
        })
        view.addEventListener('create-overlay', () => {
          const list = useStore.getState().library.find(b => b.hash === hash)?.annotations ?? []
          for (const a of list) if (!a.deleted) view.addAnnotation({ value: a.cfi, color: a.color })
        })
        // 点中已有的高亮：弹出菜单（改颜色、写笔记、删除）
        view.addEventListener('show-annotation', (ev: CustomEvent) => {
          const { value, range } = ev.detail
          const a = useStore.getState().library.find(b => b.hash === hash)?.annotations?.find(x => x.cfi === value && !x.deleted)
          if (!a || !range) return
          annoTap.current = Date.now()
          const doc = range.startContainer?.ownerDocument as Document | undefined
          const frame = doc?.defaultView?.frameElement as HTMLElement | null
          const fr = frame?.getBoundingClientRect() ?? { left: 0, top: 0 }
          const r = range.getBoundingClientRect()
          setSel({
            cfi: a.cfi,
            text: a.text,
            fraction: a.fraction,
            chapter: a.chapter ?? '',
            existing: a,
            rect: { left: fr.left + r.left, top: fr.top + r.top, bottom: fr.top + r.bottom, width: r.width },
          })
        })
        hostRef.current!.append(view)
        await view.open(book)
        // 分页器层的 relocate 先于 view 层触发：记下本章内的位置用于页码
        view.renderer?.addEventListener('relocate', (ev: CustomEvent) => {
          secFrac = Number(ev.detail?.fraction) || 0
          secSize = Number(ev.detail?.size) || 0
        })
        if (cancelled) return
        applyAll()
        setToc(book.toc ?? [])
        // 打开书的这段时间里拉取可能已经完成：直接用最新进度
        if (pullDone) rec = useStore.getState().library.find(b => b.hash === hash) ?? rec
        const isNewer = (p?: Progress) => !!p && p.cfi !== before?.cfi && (p.updatedAt ?? 0) > (before?.updatedAt ?? 0)
        savedCfi.current = rec.progress?.cfi
        localProgressAt.current = rec.progress?.updatedAt ?? 0
        await view.init({ lastLocation: rec.progress?.cfi, showTextStart: !rec.progress })
        if (cancelled) return
        setStatus('ready')
        lastTick.current = Date.now()
        if (isNewer(rec.progress)) useStore.getState().showToast(tr('已同步另一台设备的进度：{chapter}', { chapter: rec.progress?.chapter ?? '' }))
        else if (pull && !pullDone) {
          // 还没拉完：拉完后若另一台设备读得更后，且本机刚打开没怎么翻，就跳过去
          pull.then(async () => {
            const p = useStore.getState().library.find(b => b.hash === hash)?.progress
            if (cancelled || !isNewer(p) || !p || !viewRef.current) return
            proposeRemote(p)
          })
        }
      } catch (e) {
        console.error(e)
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      }
    })()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      clearTimeout(syncTimer.current)
      flushProgress()
      // 退出书籍立刻同步
      useStore.getState().syncQuick('push')
      if (view) {
        view.close?.()
        view.remove()
      }
      book?.destroy?.()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash])

  /* ---------- 打开书时的文字特效 ---------- */
  useEffect(() => {
    if (!textFx || status !== 'ready' || !fxHold) return
    let alive = true
    let skip: (() => void) | undefined
    const opts = { capture: true, passive: true }
    const stopListening = () => {
      window.removeEventListener('pointerdown', onAny, opts)
      window.removeEventListener('keydown', onAny, opts)
    }
    const release = () => {
      if (!alive) return
      alive = false
      stopListening()
      // 书页立刻显示在画布下面（最后一帧的字和书页上的字一模一样、位置重合），下一帧再撤掉画布。
      // 不做两层同时半透明的交叉淡化：那样文字会先变暗一下
      setFxHold(false)
      const layer = fxLayer.current
      if (layer) setTimeout(() => layer.replaceChildren(), 80)
    }
    // 你点一下、按一下键：不再等特效，直接显示书页（这一下的翻页等操作照常生效）
    const onAny = () => {
      skip?.()
      release()
    }
    window.addEventListener('pointerdown', onAny, opts)
    window.addEventListener('keydown', onAny, opts)
    // 等排版、字体都稳定下来（两帧 + 字体就绪）再量字的位置
    const doc: Document | undefined = viewRef.current?.renderer?.getContents?.()?.[0]?.doc
    const fontsReady = doc?.fonts?.ready ?? Promise.resolve()
    // 兜底：无论如何 8 秒内一定显示书页（慢速动画 + 长页面也够播完）
    const t = setTimeout(release, 8000)
    // 不依赖 requestAnimationFrame（界面在后台时它会暂停）：用定时器等排版落定，并等到第一屏的位置算出来
    const waitLaidOut = async () => {
      for (let i = 0; i < 24 && alive; i++) {
        if (viewRef.current?.lastLocation?.range && i >= 1) return
        await new Promise(res => setTimeout(res, 50))
      }
    }
    Promise.race([fontsReady, new Promise(r => setTimeout(r, 600))])
      .then(waitLaidOut)
      .then(() => {
        if (!alive || !fxLayer.current) return
        // 屏幕上所有可见的章节（双栏时两栏可能分属前后两章）
        const docs: Document[] = (viewRef.current?.renderer?.getContents?.() ?? []).map((c: { doc: Document }) => c.doc).filter(Boolean)
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#d97757'
        const fx = playTextFx(textFx, docs, fxLayer.current, accent)
        if (!fx) return release()
        skip = fx.skip
        return fx.done.then(release)
      })
      .catch(release)
    return () => {
      alive = false
      clearTimeout(t)
      skip?.()
      stopListening()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, textFx])

  /* ---------- 计时器 + 切后台/回前台同步 ---------- */
  useEffect(() => {
    const id = setInterval(tick, 15_000)
    let hiddenAt = 0
    const onVis = async () => {
      if (document.visibilityState === 'hidden') {
        // 切到后台时的保存与上传由 App 统一处理（store.pushOnLeave），这里只记下时间
        hiddenAt = Date.now()
        return
      }
      lastTick.current = Date.now()
      touch()
      if (!hiddenAt || Date.now() - hiddenAt < 5000) return
      // 回到前台：看看另一台设备有没有读到更后面
      await useStore.getState().syncQuick('pull', 6000)
      const rec = useStore.getState().library.find(b => b.hash === hash)
      const p = rec?.progress
      if (p && p.updatedAt > localProgressAt.current && p.cfi !== locStore.current.get().cfi && viewRef.current) {
        proposeRemote(p)
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(id)
      tick()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [tick, flushProgress, hash])

  /* ---------- 高亮：书架数据变化时同步到书页 ---------- */
  const annotations = useStore(s => s.library.find(b => b.hash === hash)?.annotations)
  const drawn = useRef(new Map<string, string>())
  useEffect(() => {
    const view = viewRef.current
    if (!view || status !== 'ready') return
    const live = (annotations ?? []).filter(a => !a.deleted)
    const want = new Map(live.map(a => [a.cfi, a.color]))
    for (const cfi of [...drawn.current.keys()])
      if (!want.has(cfi)) {
        view.deleteAnnotation({ value: cfi })
        drawn.current.delete(cfi)
      }
    for (const a of live)
      if (drawn.current.get(a.cfi) !== a.color) {
        view.addAnnotation({ value: a.cfi, color: a.color })
        drawn.current.set(a.cfi, a.color)
      }
  }, [annotations, status])

  const noteRef = useRef<SelectionInfo | null>(null)
  noteRef.current = noteFor
  const closeSel = () => {
    viewRef.current?.deselect?.()
    setSel(null)
  }
  const highlight = (s: SelectionInfo, color: HighlightColor, note?: string) => {
    const st = useStore.getState()
    if (s.existing) st.saveAnnotation(hash, { ...s.existing, color, ...(note !== undefined ? { note } : {}) })
    else st.saveAnnotation(hash, { cfi: s.cfi, text: s.text, color, fraction: s.fraction, chapter: s.chapter, ...(note ? { note } : {}) })
  }

  /* ---------- 书签（按钮与快捷键共用） ---------- */
  const toggleBookmarkRef = useRef(() => {})
  toggleBookmarkRef.current = () => {
    const st = useStore.getState()
    const l = locStore.current.get()
    const mark = st.library.find(b => b.hash === hash)?.bookmarks.find(b => !b.deleted && b.cfi === l.cfi)
    if (mark) return st.removeBookmark(hash, mark.id)
    const range: Range | undefined = viewRef.current?.lastLocation?.range
    const text = range?.toString().replace(/\s+/g, ' ').trim().slice(0, 80) ?? ''
    st.addBookmark(hash, { cfi: l.cfi, label: l.chapter || title, text, fraction: l.fraction })
    st.showToast(tr('已添加书签'))
  }
  const toggleDarkRef = useRef(() => {})

  /* ---------- 应用排版与样式 ---------- */
  const applyAll = () => {
    const view = viewRef.current
    const r = view?.renderer
    if (!r) return
    const { reading, behavior } = useStore.getState().settings
    // 直接用本次渲染的深浅色状态；不能读根节点的 data-theme，
    // 因为子组件的 effect 先于 App 的 effect 执行，读到的是上一次的值
    const th = activeReaderTheme(reading)
    r.setAttribute('flow', behavior.flow)
    r.setAttribute('gap', `${reading.marginX}%`)
    // 上下留白至少要容纳页眉页脚 + 刘海/状态栏区域，避免状态栏压到正文
    const safe = safeInsets()
    const [roomTop, roomBottom] = statusRooms(behavior)
    // 新版引擎上下边距分开设置
    r.setAttribute('margin-top', `${Math.max(reading.marginY, safe.top + roomTop)}px`)
    r.setAttribute('margin-bottom', `${Math.max(reading.marginY, safe.bottom + roomBottom)}px`)
    r.setAttribute('max-inline-size', `${reading.maxWidth}px`)
    r.setAttribute('max-column-count', String(reading.columns))
    r.toggleAttribute('animated', behavior.animated)
    view.toggleAttribute('autohide-cursor', behavior.autoHideCursor)
    r.setStyles?.(bookCSS(reading, th, useStore.getState().customFonts, formatRef.current === 'txt'))
  }
  // 只在排版相关的设置真的变了才重新套样式（重排整本书是看得见的）：
  // 亮度、进度条开关这类与排版无关的设置，以及同步后“内容相同的新对象”，都不触发
  const styleKey = JSON.stringify([{ ...reading, brightness: 0 }, { ...behavior, showSlider: false, sliderMode: 'book', volumeKeys: false, syncOnOpen: false }])
  useEffect(() => {
    if (status === 'ready') applyAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, styleKey, customFonts])

  // 沉浸模式隐藏/显示系统栏、旋转屏幕后安全区会变：重新计算上下留白
  useEffect(() => {
    if (status !== 'ready') return
    let t: ReturnType<typeof setTimeout>
    const onResize = () => {
      clearTimeout(t)
      t = setTimeout(() => {
        const r = viewRef.current?.renderer
        if (!r) return
        const { reading, behavior } = useStore.getState().settings
        const safe = safeInsets()
        const [roomTop, roomBottom] = statusRooms(behavior)
        r.setAttribute('margin-top', `${Math.max(reading.marginY, safe.top + roomTop)}px`)
        r.setAttribute('margin-bottom', `${Math.max(reading.marginY, safe.bottom + roomBottom)}px`)
      }, 200)
    }
    window.addEventListener('resize', onResize)
    return () => {
      clearTimeout(t)
      window.removeEventListener('resize', onResize)
    }
  }, [status])

  const goTo = (target: string) => {
    viewRef.current?.goTo(target)
    setPanel(null)
    setChrome(false)
  }

  /** 月亮/太阳：只切换阅读背景（日间背景 ↔ 夜间背景），不影响书架等界面 */
  toggleDarkRef.current = () => toggleDark()
  const toggleDark = () =>
    // 整屏渐变过去（书页、工具栏一起），不再“啪”地一下变色
    fadeTransition(() =>
      useStore.getState().updateSettings(s => {
        const r = s.reading
        const isDark = readerTheme(r).dark
        const day = r.dayTheme && !readerTheme(r, r.dayTheme).dark ? r.dayTheme : 'parchment'
        const night = readerTheme(r, r.darkTheme).dark ? r.darkTheme : 'night'
        return { ...s, reading: isDark ? { ...r, theme: day } : { ...r, dayTheme: r.theme, theme: night } }
      }),
    )

  return (
    <div
      className={`reader ${theme.dark ? 'theme-dark' : 'theme-light'} ${behavior.flow === 'scrolled' ? 'scrolled' : ''} ${closing ? 'closing' : ''}`}
      style={{ background: theme.bg, color: theme.fg, '--reader-bg': theme.bg } as React.CSSProperties}
    >
      <div
        ref={hostRef}
        className={`reader-host ${status === 'ready' && !fxHold ? 'shown' : ''} ${textFx ? 'fx-instant' : ''}`}
        onClick={e => {
          if (e.target === e.currentTarget || (e.target as Element).tagName === 'FOLIATE-VIEW') handleTap(e.clientX)
        }}
        onWheel={e => handleWheel(e.nativeEvent)}
      />

      {textFx && <div className="textfx" ref={fxLayer} aria-hidden />}

      {(status === 'loading' || status === 'syncing') && (
        <div className="loading">
          <span className="loading-dot" />
          {status === 'syncing' ? tr('正在同步阅读进度…') : tr('正在打开…')}
        </div>
      )}
      {status === 'error' && (
        <div className="loading" style={{ flexDirection: 'column', gap: 16, padding: 24, textAlign: 'center' }}>
          <div>{tr('打开失败：{e}', { e: error })}</div>
          <button className="btn" onClick={exitReader}>
            {tr('返回书架')}
          </button>
        </div>
      )}

      {status === 'ready' && behavior.showStatusBar && !chrome && (
        <StatusOverlay
          store={locStore.current}
          title={title}
          color={theme.fg}
          status={behavior.status ?? DEFAULT_STATUS}
          size={behavior.statusSize ?? 'md'}
          sessionStart={sessionStart.current}
        />
      )}

      {/* 工具栏隐藏时去掉毛玻璃并 visibility:hidden，翻页时零合成开销 */}
      <div className={`bar top ${chrome ? 'glass' : 'hidden'}`}>
        <button className="icon-btn" aria-label={tr('返回')} onClick={exitReader}>
          <IconBack />
        </button>
        <div className="title">{title}</div>
        {deviceClass === 'desktop' && (
          <button className="icon-btn" aria-label={tr('全屏')} title={tr('全屏（F11）')} onClick={() => toggleFullscreen().catch(() => {})}>
            <IconFullscreen />
          </button>
        )}
        <button className="icon-btn" aria-label={tr('书内搜索')} title={tr('书内搜索')} onClick={() => setPanel('search')}>
          <IconSearch />
        </button>
        <BookmarkButton store={locStore.current} hash={hash} title={title} viewRef={viewRef} />
      </div>

      <div className={`bar bottom ${chrome ? 'glass' : 'hidden'}`}>
        <ProgressBar
          store={locStore.current}
          viewRef={viewRef}
          slider={!!behavior.showSlider}
          mode={behavior.sliderMode ?? 'book'}
          onMode={m => useStore.getState().updateSettings(s => ({ ...s, behavior: { ...s.behavior, sliderMode: m } }))}
        />
        <div className="bar-actions">
          <TocButton
            onOpen={() => {
              setTocPull(null)
              setTocTab(tocTab === 'notes' ? 'notes' : 'toc')
              setPanel('toc')
            }}
            onPull={p => {
              setTocPull(p)
              setTocTab(tocTab === 'notes' ? 'notes' : 'toc')
              setPanel('toc')
            }}
          />
          <button className="icon-btn" aria-label={tr('排版')} onClick={() => (setStyleTab('look'), setPanel('style'))}>
            <IconType />
          </button>
          <ThemeButton
            dark={theme.dark}
            brightness={reading.brightness ?? -1}
            onToggle={toggleDark}
            onPreview={setBrightPreview}
            onCommit={v => useStore.getState().updateSettings(s => ({ ...s, reading: { ...s.reading, brightness: Number(v.toFixed(2)) } }))}
          />
          <button className="icon-btn" aria-label={tr('阅读设置')} onClick={() => (setStyleTab('behavior'), setPanel('style'))}>
            <IconSettings />
          </button>
        </div>
        {localOnly && <div style={{ fontSize: 11.5, textAlign: 'center', color: 'var(--muted)' }}>{tr('这本书仅保存在本机，不会同步')}</div>}
      </div>

      {/* 没有原生亮度接口的平台：盖一层黑色遮罩调暗（不挡操作） */}
      {!nativeBright && brightness >= 0 && brightness < 1 && <div className="reader-dim" style={{ opacity: dimOpacity(brightness) }} aria-hidden />}

      <Presence show={!!panel}>
        <div className="scrim dim fade-in" style={{ zIndex: 35 }} onClick={() => setPanel(null)} />
      </Presence>

      <Presence show={!!offer}>
        {offer && (
        <div className="sync-offer glass" role="status">
          <span>
            {tr('另一台设备读到了')} <b>{offer.chapter || `${Math.round((offer.fraction ?? 0) * 100)}%`}</b>
          </span>
          <button
            className="btn ghost"
            onClick={() => {
              // 留在这里：把当前位置记为最新进度，同步后其他设备也以这里为准
              const l = locStore.current.get()
              if (l.cfi) progressRef.current = { cfi: l.cfi, fraction: l.fraction, chapter: l.chapter, updatedAt: Date.now() }
              savedCfi.current = undefined
              flushProgress()
              useStore.getState().syncQuick('push')
              setOffer(null)
            }}
          >
            {tr('留在这里')}
          </button>
          <button
            className="btn primary"
            onClick={() => {
              savedCfi.current = offer.cfi
              localProgressAt.current = offer.updatedAt
              viewRef.current?.goTo(offer.cfi)
              setOffer(null)
            }}
          >
            {tr('跳过去')}
          </button>
        </div>
      )}
      </Presence>
      <Presence show={panel === 'toc'}>
        {panel === 'toc' && (
        <TocSheet
          hash={hash}
          store={locStore.current}
          toc={toc}
          onGo={goTo}
          tab={tocTab}
          setTab={setTocTab}
          onClose={() => setPanel(null)}
          pull={tocPull}
          onEditNote={a => setNoteFor({ cfi: a.cfi, text: a.text, fraction: a.fraction, chapter: a.chapter ?? '', existing: a, rect: { left: 0, top: 0, bottom: 0, width: 0 } })}
        />
      )}
      </Presence>
      <Presence show={panel === 'search'}>
        {panel === 'search' && (
        <SearchSheet
          viewRef={viewRef}
          state={search}
          setState={setSearch}
          onClose={() => setPanel(null)}
          onGo={cfi => {
            viewRef.current?.goTo(cfi)
            setPanel(null)
          }}
        />
      )}
      </Presence>
      <Presence show={!!sel && !panel}>
        {sel && !panel && (
        <SelectionMenu
          sel={sel}
          onColor={c => {
            highlight(sel, c)
            closeSel()
          }}
          onNote={() => {
            setNoteFor(sel)
            closeSel()
          }}
          onCopy={() => {
            navigator.clipboard?.writeText(sel.text).then(
              () => useStore.getState().showToast(tr('已复制')),
              () => {},
            )
            closeSel()
          }}
          onDelete={
            sel.existing
              ? () => {
                  useStore.getState().removeAnnotation(hash, sel.existing!.id)
                  closeSel()
                }
              : undefined
          }
        />
      )}
      </Presence>
      <Presence show={!!noteFor}>
        {noteFor && (
        <NoteDialog
          text={noteFor.text}
          note={noteFor.existing?.note ?? ''}
          onClose={() => setNoteFor(null)}
          onSave={note => {
            highlight(noteFor, noteFor.existing?.color ?? 'yellow', note)
            setNoteFor(null)
            useStore.getState().showToast(tr('笔记已保存'))
          }}
        />
      )}
      </Presence>

      <Presence show={panel === 'style'}>
        {panel === 'style' && (
        <Sheet onClose={() => setPanel(null)}>
          <div className="tabs">
            <Segmented
              value={styleTab}
              options={[
                ['look', tr('外观')],
                ['behavior', tr('翻页与操作')],
              ]}
              onChange={setStyleTab}
            />
          </div>
          {styleTab === 'look' ? <AppearanceControls compact /> : <BehaviorControls />}
        </Sheet>
      )}
      </Presence>
    </div>
  )
}
