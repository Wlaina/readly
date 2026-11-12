import { lazy, startTransition, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { interruptedBook, useStore } from './lib/store'
import { resolveFont } from './lib/fonts'
import { enterReader, useAppDark, useDesktopLayout } from './lib/hooks'
import { isWindowsApp, onOpenFiles, setNativeThemeMode, setSystemBarsDark, takePendingOpenFiles, toggleFullscreen } from './lib/native'
import { applyAccent, resolveAccent } from './lib/accent'
import { isTauri } from './lib/storage'
import { useTasks } from './lib/tasks'
import { applyMotion, setMotionSpeed } from './lib/motion'
import { setLang } from './lib/i18n'
import { autoCheck } from './lib/updater'
import { closeFx, FADE_MS, getOpenMs } from './lib/bookfx'
import UpdateBanner from './components/UpdateBanner'
import Presence from './components/Presence'
import { setHaptics } from './lib/native'
import Library from './components/Library'
import SyncPage from './components/SyncPage'
import SettingsPage from './components/SettingsPage'
import OpenFileDialog from './components/OpenFileDialog'
import StatsPage from './components/StatsPage'
import Dock from './components/Dock'
import ConfirmDialog from './components/ConfirmDialog'
import Onboarding from './components/Onboarding'
import { IconChart, IconFullscreen, IconSettings, IconShelf, IconSync } from './components/icons'
import { tr } from './lib/i18n'

const loadReader = () => import('./components/Reader')
const Reader = lazy(loadReader)

let windowShown = false

type Tab = 'shelf' | 'stats' | 'sync' | 'settings'

const TABS: { id: Tab; label: string; icon: (p: React.SVGProps<SVGSVGElement>) => React.ReactElement }[] = [
  { id: 'shelf', label: '书架', icon: IconShelf },
  { id: 'stats', label: '统计', icon: IconChart },
  { id: 'sync', label: '同步', icon: IconSync },
  { id: 'settings', label: '设置', icon: IconSettings },
]

/**
 * 一个标签页：不活动时隐藏（保留状态与滚动位置），变为活动时只播放一次整页入场动画。
 * 阅读时这些页面也保持挂载（整块隐藏、数据冻结），合上书时书架原样还在，不会重建、不会闪。
 */
function TabPane({ active, children }: { active: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  const [booting, setBooting] = useState(true)
  useLayoutEffect(() => {
    const el = ref.current
    // 隐藏的页面不能被 Tab 键或读屏聚焦到
    if (el) (el as HTMLElement & { inert: boolean }).inert = !active
    if (!el) return
    if (first.current) {
      first.current = false
      if (!active) return setBooting(false)
      // 第一次挂载：先藏着，等真正画出来（两帧之后）再播入场动画。
      // 冷启动时挂载书架很忙，直接播的话动画在第一帧画出来之前就播完了，看起来是“啪”地一下出现
      // 冷启动时和背景、底栏一起入场（等 App 把 data-boot 设为 in）；之后切到新页面时等两帧即可
      const root = document.documentElement
      let raf = 0
      let n = 0
      const tick = () => {
        if (root.dataset.boot === 'wait' || ++n < 2) raf = requestAnimationFrame(tick)
        else setBooting(false)
      }
      raf = requestAnimationFrame(tick)
      return () => {
        cancelAnimationFrame(raf)
        setBooting(false)
      }
    }
    if (!active) return
    el.classList.remove('page-anim')
    void el.offsetWidth // 重新触发入场动画
    el.classList.add('page-anim')
  }, [active])
  return (
    <div ref={ref} className={`tab-pane ${booting ? 'pre-anim' : 'page-anim'} ${active ? '' : 'inactive'}`} aria-hidden={!active}>
      {children}
    </div>
  )
}

/** 切换语言时整体重新挂载界面（tr() 在渲染时取词）；当前标签页单独记住，切换后仍停在原页 */
let lastTab: Tab = 'shelf'
let resumed = false
let initStarted = false

export default function AppRoot() {
  const lang = useStore(s => s.settings.lang ?? 'zh')
  setLang(lang)
  return <App key={lang} />
}

function App() {
  const ready = useStore(s => s.ready)
  const reading = useStore(s => s.reading)
  const toast = useStore(s => s.toast)
  const monet = useStore(s => s.settings.monet)
  const uiFont = useStore(s => s.settings.uiFont)
  const accent = useStore(s => s.settings.accent)
  const accentCustom = useStore(s => s.settings.accentCustom)
  const motion = useStore(s => s.settings.motion)
  const motionSpeed = useStore(s => s.settings.motionSpeed ?? 'normal')
  const onboarded = useStore(s => s.settings.onboarded)
  const dockLabels = useStore(s => s.settings.dockLabels ?? true)
  const customFonts = useStore(s => s.customFonts)
  const [tab, setTabState] = useState<Tab>(lastTab)
  const setTab = (t: Tab) => setTabState((lastTab = t))
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([lastTab]))
  useEffect(() => setVisited(v => (v.has(tab) ? v : new Set(v).add(tab))), [tab])
  const glass = useStore(s => s.settings.glass ?? 'clear')
  const monetLevel = useStore(s => s.settings.monetLevel ?? 'standard')
  const haptics = useStore(s => s.settings.haptics ?? true)
  const resumeLast = useStore(s => s.settings.resumeLast)
  const [openPaths, setOpenPaths] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const dark = useAppDark()
  const themeMode = useStore(s => s.settings.appTheme)
  const desktop = useDesktopLayout()
  const runningTasks = useTasks(s => s.tasks.filter(t => t.status === 'running').length)

  // 只初始化一次：切换语言会重新挂载 App，不能再次从磁盘读取旧设置
  useEffect(() => {
    if (initStarted) return
    initStarted = true
    useStore.getState().init()
    // 提前把阅读器的代码加载好：第一次开书时不用等，开书动画不会被打断
    setTimeout(() => loadReader().catch(() => {}), 1200)
  }, [])

  /* ---------- 开书 / 合书 ----------
     合上书时阅读器先留着播放退场，书架此刻已经显示在它下面；
     打开书时书架要等阅读器完全盖住之后才藏起来。 */
  const [seen, setSeen] = useState(reading)
  const [closing, setClosing] = useState<string | null>(null)
  if (seen !== reading) {
    setSeen(reading)
    setClosing(seen && !reading ? seen : null)
  }
  useLayoutEffect(() => {
    if (!closing) return
    // 这时书架已经换成最新数据并排好版，可以量出封面现在的位置
    const ms = closeFx(closing) || FADE_MS
    const t = setTimeout(() => setClosing(null), ms)
    return () => clearTimeout(t)
  }, [closing])
  /*
   * 书页盖住书架之后，分两步把书架“收起来”：
   * 1. 动画一结束：只暂停莫奈背景（改动很小）。
   * 2. 等浏览器空下来（书已经排好版）：才把整个书架设为不渲染，省显存。
   * 以前动画一结束就同时做这两步，正赶上书在排版，主线程一下子被占满，动画末尾会顿一下。
   */
  const [covered, setCovered] = useState(false)
  const [parked, setParked] = useState(false)
  useEffect(() => {
    if (!reading) {
      setCovered(false)
      setParked(false)
      return
    }
    const open = getOpenMs() || FADE_MS
    let idle = 0
    const t1 = setTimeout(() => setCovered(true), open + 40)
    const t2 = setTimeout(() => {
      if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(() => setParked(true), { timeout: 4000 })
      else setParked(true)
    }, open + 1500)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      if (idle && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle)
    }
  }, [reading])
  const monetHidden = !!reading && covered
  const appHidden = !!reading && parked
  const shownBook = reading ?? closing

  // 电脑端：导航移到左侧（CSS 根据这个类调整页面边距）；F11 全屏
  useEffect(() => {
    document.documentElement.classList.toggle('nav-side', desktop)
  }, [desktop])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault()
        toggleFullscreen().catch(() => {})
        return
      }
      // Ctrl+1~4：切换书架 / 统计 / 同步 / 设置（阅读时不响应）
      if ((e.ctrlKey || e.metaKey) && /^[1-4]$/.test(e.key) && !useStore.getState().reading) {
        e.preventDefault()
        startTransition(() => setTab(TABS[Number(e.key) - 1].id))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 动画风格、玻璃通透度、莫奈强度、触感、导航文字
  useLayoutEffect(() => applyMotion(motion), [motion])
  useLayoutEffect(() => setMotionSpeed(motionSpeed), [motionSpeed])
  useLayoutEffect(() => {
    document.documentElement.dataset.glass = glass
    document.documentElement.dataset.monet = monetLevel
    document.documentElement.dataset.dock = dockLabels ? 'labels' : 'icons'
  }, [glass, monetLevel, dockLabels])
  useEffect(() => void setHaptics(haptics), [haptics])

  // 启动后自动检查更新（距上次检查超过 12 小时才查）
  const autoUpdate = useStore(s => s.settings.autoUpdate ?? true)
  useEffect(() => {
    if (ready && autoUpdate) autoCheck()
  }, [ready, autoUpdate])

  // 启动时继续上次阅读（只在冷启动时一次；有“用 Readly 打开”的文件时以文件为准；第一次启动先看引导）
  useEffect(() => {
    if (!ready || resumed) return
    resumed = true
    const st = useStore.getState()
    // 上次是在阅读途中被系统回收（或崩溃）的：不管有没有开“启动时继续阅读”，都直接回到那本书
    const cut = interruptedBook()
    if (openPaths.length || st.reading || !st.settings.onboarded) return
    const readable = st.library.filter(b => !b.deletedAt && b.hasFile)
    const back = cut ? readable.find(b => b.hash === cut) : undefined
    if (back) {
      console.info(`上次在阅读途中被中断，已回到《${back.title}》`)
      return enterReader(back.hash)
    }
    if (!resumeLast) return
    const last = readable.filter(b => b.lastReadAt).sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))[0]
    if (last) enterReader(last.hash)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // 应用主题与界面字体（用 layoutEffect：渐变切换时，新快照里已经是新的深浅色）
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    // 记住深浅色：下次启动在首帧之前就套上（index.html 里的小脚本读取）
    try {
      localStorage.setItem('readly.theme', dark ? 'dark' : 'light')
    } catch {
      /* 忽略 */
    }
    // 阅读时系统栏跟着阅读背景走（由阅读器设置），这里不去抢
    if (!useStore.getState().reading) setSystemBarsDark(dark)
    // Windows 标题栏跟随 Readly 的深浅色，而不是系统主题；
    // 窗口和 WebView 自己的底色也换成同色：关闭、结束任务时网页先被拆掉，露出的是这层底色（以前固定是浅色，会闪一下白）
    if (isWindowsApp) {
      const color = dark ? { red: 0x14, green: 0x14, blue: 0x13, alpha: 255 } : { red: 0xf5, green: 0xf4, blue: 0xed, alpha: 255 }
      import('@tauri-apps/api/window')
        .then(m => {
          const w = m.getCurrentWindow()
          return Promise.all([w.setTheme(dark ? 'dark' : 'light'), w.setBackgroundColor(color)])
        })
        .catch(e => console.warn('设置标题栏主题失败', e))
      import('@tauri-apps/api/webview')
        .then(m => m.getCurrentWebview().setBackgroundColor(color))
        .catch(e => console.warn('设置网页底色失败', e))
    }
  }, [dark])

  // 记住主题模式：下次启动的首帧（index.html）和安卓原生底色据此决定，跟随系统时看系统此刻的深浅色
  useEffect(() => {
    try {
      localStorage.setItem('readly.themeMode', themeMode)
    } catch {
      /* 忽略 */
    }
    setNativeThemeMode(themeMode)
  }, [themeMode])

  // 冷启动入场：背景和底栏在 index.html 里先藏着，数据读完、书架画出来（两帧之后）再和书架一起淡入，
  // 不再是背景、底栏先“啪”地出现，书架过一会儿才浮上来。3 秒还没准备好也照样显示，免得一直空白
  useEffect(() => {
    const root = document.documentElement
    if (root.dataset.boot !== 'wait') return
    const show = () => {
      if (root.dataset.boot !== 'wait') return
      root.dataset.boot = 'in'
      setTimeout(() => delete root.dataset.boot, 700)
    }
    if (!ready) {
      const t = setTimeout(show, 3000)
      return () => clearTimeout(t)
    }
    // 等画面真正开始稳定出帧再淡入：冷启动时第一帧要画很久（封面、模糊背景），
    // 动画如果在这之前开始，等画面出来时已经播完了，看起来还是“啪”地一下
    let raf = 0
    let last = 0
    let smooth = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      smooth = last && now - last < 24 ? smooth + 1 : 0
      last = now
      if (smooth >= 3 || now - t0 > 1500) {
        console.info(`[boot] 入场淡入：数据就绪后 ${Math.round(now - t0)}ms`)
        show()
      } else raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ready])

  // 窗口启动时是隐藏的：设置读完、深浅色套好、画完两帧之后再显示，避免白屏一闪
  useEffect(() => {
    if (!ready || !isTauri || windowShown) return
    windowShown = true
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        import('@tauri-apps/api/window')
          .then(m => m.getCurrentWindow().show())
          .catch(() => {})
      }),
    )
  }, [ready])
  // 主题色；选“系统动态取色”时回到前台再取一次（系统壁纸/强调色可能变了）
  useEffect(() => {
    let cur = ''
    const apply = () =>
      resolveAccent(accent, accentCustom).then(c => {
        // 颜色没变就不动根节点：改根节点的变量会让整页重新计算样式
        if (c === cur) return
        cur = c
        applyAccent(c)
      })
    apply()
    if (accent !== 'system') return
    const onVis = () => document.visibilityState === 'visible' && apply()
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [accent, accentCustom])

  useEffect(() => {
    const f = resolveFont(uiFont, customFonts, false)
    document.documentElement.style.setProperty('--font-ui', f.family!)
  }, [uiFont, customFonts])

  // 离开应用时立刻保存并上传阅读记录：手机切到后台（回桌面、锁屏、切应用）、电脑最小化或切走
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden' && useStore.getState().ready) useStore.getState().pushOnLeave()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // Windows：点关闭按钮时先保存进度并上传，再真正退出（最多等 3.5 秒，窗口先隐藏，不耽误你）
  useEffect(() => {
    if (!isWindowsApp) return
    let un: (() => void) | undefined
    let dead = false
    let leaving = false
    import('@tauri-apps/api/window')
      .then(async m => {
        const w = m.getCurrentWindow()
        const off = await w.onCloseRequested(async e => {
          e.preventDefault()
          if (leaving) return
          leaving = true
          try {
            await w.hide().catch(() => {})
            await useStore.getState().pushOnLeave(3500)
          } catch (err) {
            console.warn('退出前同步失败', err)
          } finally {
            w.destroy().catch(() => {})
          }
        })
        if (dead) off()
        else un = off
      })
      .catch(e => console.warn('无法监听窗口关闭', e))
    return () => {
      dead = true
      un?.()
    }
  }, [])

  // “用 Readly 打开”的文件
  useEffect(() => {
    if (!ready) return
    const takeNow = () => takePendingOpenFiles().then(p => p.length && setOpenPaths(x => [...x, ...p]))
    // 安卓复制文件是异步的，稍后再取一次
    const take = () => {
      takeNow()
      setTimeout(takeNow, 1500)
    }
    take()
    // 安卓中转页复制好文件后会直接调用这个函数
    ;(window as unknown as { __readlyOpenFiles?: () => void }).__readlyOpenFiles = take
    let un: (() => void) | undefined
    onOpenFiles(p => setOpenPaths(x => [...x, ...p])).then(f => (un = f))
    // 安卓：应用在后台时从文件管理器“用 Readly 打开”，回到前台再取
    const onVis = () => document.visibilityState === 'visible' && take()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      un?.()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [ready])

  // 拖放导入
  useEffect(() => {
    let depth = 0
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      depth++
      setDragging(true)
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? []).filter(f => /\.(epub|txt)$/i.test(f.name))
      if (files.length) useStore.getState().importFiles(files)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  // 触摸、滑动、滚动时暂停莫奈背景：背景不动，导航栏的毛玻璃就不用每帧重新模糊，手指下的动画更跟手
  useEffect(() => {
    // 只给背景元素加类名，不动 <html>：改根节点类名会让整页重新计算样式
    const root = { classList: { add: (c: string) => document.querySelector('.monet')?.classList.add(c), remove: (c: string) => document.querySelector('.monet')?.classList.remove(c) } }
    let t: ReturnType<typeof setTimeout> | undefined
    const busy = () => {
      if (!t) root.classList.add('busy')
      clearTimeout(t)
      t = setTimeout(() => {
        t = undefined
        root.classList.remove('busy')
      }, 700)
    }
    const opts = { capture: true, passive: true }
    for (const ev of ['pointerdown', 'pointermove', 'wheel', 'scroll', 'keydown']) window.addEventListener(ev, busy, opts)
    return () => {
      for (const ev of ['pointerdown', 'pointermove', 'wheel', 'scroll', 'keydown']) window.removeEventListener(ev, busy, opts)
      clearTimeout(t)
    }
  }, [])

  // 安卓返回键 / 浏览器后退：关闭阅读器
  useEffect(() => {
    const onPop = () => {
      // 回退后仍停在阅读器的记录上（例如只是关掉了目录/外观面板）：不退出书籍
      if (history.state?.reader) return
      if (useStore.getState().reading) useStore.getState().openReader(null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  return (
    <>
      {/* 阅读时背景暂停并隐藏（不卸载：退出阅读时不会从头开始流动、闪一下） */}
      <div className={`monet ${monetHidden ? 'paused' : ''}`} style={monetHidden ? { visibility: 'hidden' } : undefined} aria-hidden>
        {monet && (
          <>
            <i />
            <i />
            <i />
          </>
        )}
      </div>
      <div className={`app ${appHidden ? 'covered' : ''}`} style={appHidden ? { visibility: 'hidden' } : undefined}>
        {ready && (
          <>
            {/* 去过的页面保持挂载、只切换显示：切回来时不再重建整页、重放入场动画、重新加载封面。
                阅读时也不卸载（数据冻结，见 useShelf），合上书时书架原样还在 */}
            {TABS.filter(x => visited.has(x.id)).map(x => (
              <TabPane key={x.id} active={x.id === tab}>
                {x.id === 'shelf' && <Library />}
                {x.id === 'stats' && <StatsPage />}
                {x.id === 'sync' && <SyncPage />}
                {x.id === 'settings' && <SettingsPage />}
              </TabPane>
            ))}
          </>
        )}
        <Dock
          tabs={TABS.map(x => ({ ...x, label: tr(x.label) }))}
          tab={tab}
          onChange={t => startTransition(() => setTab(t))}
          side={desktop}
          badges={{ sync: runningTasks }}
          extra={
            <button className="dock-fs" aria-label={tr('全屏')} title={tr('全屏（F11）')} onClick={() => toggleFullscreen().catch(() => {})}>
              <IconFullscreen />
            </button>
          }
        />
      </div>
      {shownBook && (
        <Suspense fallback={<div className="reader reader-fallback loading">{tr('正在打开…')}</div>}>
          <Reader key={shownBook} hash={shownBook} closing={!reading} />
        </Suspense>
      )}
      <Presence show={ready && !onboarded}>{ready && !onboarded && <Onboarding />}</Presence>
      <Presence show={openPaths.length > 0}>{openPaths.length > 0 && <OpenFileDialog paths={openPaths} onDone={() => setOpenPaths([])} />}</Presence>
      {!reading && onboarded && <UpdateBanner />}
      <Presence show={dragging}>
        <div className="drop-hint">{tr('松开即可导入书籍')}</div>
      </Presence>
      <Presence show={!!toast}>{toast && <div className="toast glass">{toast}</div>}</Presence>
      <ConfirmDialog />
    </>
  )
}
