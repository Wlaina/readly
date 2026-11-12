import { createPortal } from 'react-dom'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BookRecord } from '../lib/types'
import { formatDuration } from '../lib/hooks'
import { coverBackdrop, coverColor, loadCover } from '../lib/covers'
import { useStore } from '../lib/store'
import { consumeLongPress, longPress } from '../lib/longpress'
import { BookCover } from './BookCover'
import { IconChevronL, IconChevronR } from './icons'
import { tr } from '../lib/i18n'

interface Props {
  books: BookRecord[]
  selecting: boolean
  selected: Set<string>
  onOpen: (rec: BookRecord) => void
  onToggle: (rec: BookRecord) => void
  onLongPress: (rec: BookRecord) => void
  onMenu: (rec: BookRecord, x: number, y: number) => void
}

/**
 * 新版浏览器/WebView 支持“滚动驱动动画”：封面的旋转、缩放、淡出直接绑定在滚动位置上，
 * 由合成线程计算，和手指完全同步，不经过 JS（见 styles.css 的 .carousel.sda）。
 * 不支持时退回用 JS 逐帧设置 transform。
 */
const SDA = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('animation-timeline: view()')
/** 中间那本左右各保留几本参与渲染，更远的直接隐藏 */
const NEAR = 3

/**
 * 单本一排：横向轮播（3D 封面流）。中间一本最大，两侧的书向外转一点角度、缩小、变淡。
 * 手机：左右滑（可以一次甩过多本）；电脑：方向键 / 滚轮 / 两侧箭头。
 */
export default function ShelfCarousel({ books, selecting, selected, onOpen, onToggle, onLongPress, onMenu }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const raf = useRef(0)
  /** 滑动途中实时的中间那本（不触发重渲染）；active 只在停稳或将要停在哪本确定时更新 */
  const activeRef = useRef(0)
  const win = useRef<[number, number]>([0, -1])

  const step = () => (ref.current?.firstElementChild as HTMLElement | null)?.offsetWidth || 1

  /** 只让中间附近的几本参与渲染；更远的隐藏，省掉无用的图层和绘制 */
  const cull = useCallback((center: number, force = false) => {
    const el = ref.current
    if (!el) return
    const items = el.children
    const lo = Math.max(0, center - NEAR)
    const hi = Math.min(items.length - 1, center + NEAR)
    const [plo, phi] = win.current
    if (!force && lo === plo && hi === phi) return
    const from = force ? 0 : Math.min(lo, plo)
    const to = force ? items.length - 1 : Math.max(hi, phi)
    for (let i = Math.max(0, from); i <= Math.min(items.length - 1, to); i++) {
      const card = items[i] as HTMLElement
      card.classList.toggle('far', i < lo || i > hi)
      // 正中那本在最上面，越远越靠下（以前用动画逐帧改层级，那一步只能在主线程算，滑动时会卡）
      card.style.zIndex = i < lo || i > hi ? '' : String(10 - Math.abs(i - center) * 3)
    }
    win.current = [lo, hi]
  }, [])

  const paint = useCallback(
    (force = false) => {
      raf.current = 0
      const el = ref.current
      if (!el) return
      const pos = el.scrollLeft / step()
      const idx = Math.min(books.length - 1, Math.max(0, Math.round(pos)))
      cull(idx, force)
      if (!SDA) {
        // 退路：按与中心的“带方向距离”逐帧设置变换
        const items = el.children
        const [lo, hi] = win.current
        for (let i = lo; i <= hi; i++) {
          const sd = Math.max(-2, Math.min(2, i - pos)) // 左负右正
          const d = Math.abs(sd)
          const t = Math.min(d, 1)
          const card = items[i] as HTMLElement
          card.style.transform = `perspective(900px) translate3d(${-sd * 14}%, 0, ${-t * 60}px) rotateY(${-Math.sign(sd) * t * 34}deg) scale(${1 - t * 0.1})`
          card.style.opacity = String(d <= 1 ? 1 - d * 0.3 : Math.max(0, 0.7 - (d - 1) * 0.62))
          card.style.zIndex = String(10 - Math.round(d * 4))
        }
      }
      activeRef.current = idx
    },
    [books.length, cull],
  )

  // 信息区（书名/进度）显示哪一本：滑动途中直接换成“将要停下的那一本”，不在途经的每一本上闪一遍
  const [shownIdx, setShownIdx] = useState(0)
  const idle = useRef<ReturnType<typeof setTimeout>>()
  const settle = useCallback(() => {
    const el = ref.current
    if (!el) return
    const idx = Math.min(books.length - 1, Math.max(0, Math.round(el.scrollLeft / step())))
    setShownIdx(i => (i === idx ? i : idx))
    setActive(a => (a === idx ? a : idx))
  }, [books.length])
  useEffect(() => () => clearTimeout(idle.current), [])

  const onScroll = () => {
    if (!raf.current) raf.current = requestAnimationFrame(() => paint())
    clearTimeout(idle.current)
    idle.current = setTimeout(settle, 120)
  }

  // 浏览器在滑动途中就能告诉我们“松手后会停在哪一本”
  useEffect(() => {
    const el = ref.current
    if (!el || !('onscrollsnapchanging' in el)) return
    const onSnap = (e: Event) => {
      const target = (e as Event & { snapTargetInline?: Element | null }).snapTargetInline
      if (!target) return
      const idx = Array.prototype.indexOf.call(el.children, target)
      if (idx < 0) return
      setShownIdx(i => (i === idx ? i : idx))
      setActive(a => (a === idx ? a : idx))
    }
    el.addEventListener('scrollsnapchanging', onSnap)
    return () => el.removeEventListener('scrollsnapchanging', onSnap)
  }, [])

  // 书的顺序或数量变了（刚读完的书排到最前、同步、筛选分类）：让原来正中的那本书仍然在正中
  const centerHash = useRef<string | undefined>(undefined)
  /** 上面这次对齐已经处理过的那份书单 */
  const synced = useRef(books)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const want = centerHash.current ? books.findIndex(b => b.hash === centerHash.current) : -1
    const cur = Math.round(el.scrollLeft / step())
    const idx = want >= 0 ? want : Math.min(books.length - 1, Math.max(0, cur))
    if (idx !== cur) el.scrollTo({ left: idx * step(), behavior: 'instant' as ScrollBehavior })
    paint(true)
    setShownIdx(idx)
    setActive(idx)
    activeRef.current = idx
    synced.current = books
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [books])
  // 书单刚换、还没重新对齐的那一次渲染：按“原来正中的那本”取，不按旧位置取（否则信息区会先闪成另一本书）
  const rec =
    (synced.current !== books && centerHash.current ? books.find(b => b.hash === centerHash.current) : undefined) ?? books[Math.min(shownIdx, books.length - 1)]
  // 在上面的对齐（layout effect）之后才记下“现在正中是哪本”，否则顺序刚变的那一次会记错
  useEffect(() => {
    centerHash.current = rec?.hash
  })

  const goTo = useCallback(
    (i: number) => {
      const el = ref.current
      if (!el) return
      const idx = Math.min(books.length - 1, Math.max(0, i))
      el.scrollTo({ left: idx * step(), behavior: 'smooth' })
    },
    [books.length],
  )

  // 电脑：方向键切换
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || document.querySelector('.reader, .dialog, .sheet')) return
      if (!ref.current || ref.current.closest('.tab-pane.inactive')) return // 书架页被隐藏（在别的标签页）时不响应
      if (e.key === 'ArrowRight') goTo(active + 1)
      else if (e.key === 'ArrowLeft') goTo(active - 1)
      else if (e.key === 'Enter' && books[active] && !selecting) onOpen(books[active])
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, books, goTo, onOpen, selecting])

  // 电脑：竖向滚轮转成一本一本地切换
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let last = 0
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return // 横向滚动交给原生
      e.preventDefault()
      const now = Date.now()
      if (now - last < 260 || Math.abs(e.deltaY) < 6) return
      last = now
      const cur = Math.round(el.scrollLeft / step())
      goTo(cur + (e.deltaY > 0 ? 1 : -1))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [goTo])

  // 窗口大小变了（旋转屏幕、调整窗口）：封面宽度跟着变，按原来的那一本重新对齐
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let w = el.clientWidth
    const onResize = () => {
      if (el.clientWidth === w) return
      w = el.clientWidth
      const idx = centerHash.current ? books.findIndex(b => b.hash === centerHash.current) : -1
      if (idx >= 0) el.scrollTo({ left: idx * step(), behavior: 'instant' as ScrollBehavior })
      paint(true)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [books, paint])

  // 提前把左右几本的封面准备好：滑过去时封面已经在了，不会先看到一块灰底
  useEffect(() => {
    let idleId = 0
    const t = setTimeout(() => {
      const run = () => {
        for (let i = Math.max(0, shownIdx - 3); i <= Math.min(books.length - 1, shownIdx + 3); i++)
          if (books[i].hasCover) loadCover(books[i].hash, 'large').catch(() => {})
      }
      if (typeof requestIdleCallback === 'function') idleId = requestIdleCallback(run, { timeout: 600 })
      else run()
    }, 220)
    return () => {
      clearTimeout(t)
      if (idleId && typeof cancelIdleCallback === 'function') cancelIdleCallback(idleId)
    }
  }, [shownIdx, books])

  // 封面模糊渐变背景（设置里可开）：两层交替淡入淡出
  const backdropOn = useStore(s => !!s.settings.shelfBackdrop)
  const [backdropHost, setBackdropHost] = useState<Element | null>(null)
  useEffect(() => setBackdropHost(ref.current?.closest('.page') ?? null), [])
  const [backdrop, setBackdrop] = useState<[string, string, 0 | 1]>(['', '', 0])
  useEffect(() => {
    if (!backdropOn || !rec) return
    let alive = true
    const t = setTimeout(() => {
      coverBackdrop(rec.hash, rec.hasCover).then(u => {
        if (!alive || !u) return
        setBackdrop(([a, b, top]) => ((top === 0 ? a : b) === u ? [a, b, top] : top === 0 ? [a, u, 1] : [u, b, 0]))
      })
    }, 140)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [backdropOn, rec?.hash, rec?.coverRev, rec?.hasCover])

  // 点击、长按等处理函数读最新的值，但列表本身不因为它们变化而重建
  const cb = useRef({ onOpen, onToggle, onLongPress, onMenu, goTo, selecting })
  cb.current = { onOpen, onToggle, onLongPress, onMenu, goTo, selecting }
  const items = useMemo(
    () =>
      books.map((b, i) => (
        <CarouselItem key={b.hash} rec={b} index={i} selecting={selecting} selected={selected.has(b.hash)} cb={cb} activeRef={activeRef} />
      )),
    [books, selecting, selected],
  )

  const pct = Math.round((rec?.progress?.fraction ?? 0) * 100)
  const readMs = Object.values(rec?.readStats ?? {}).reduce((a, s) => a + s.ms, 0)

  // 氛围光：取当前这本书封面的主色，两层交替淡入淡出，换书时颜色柔和过渡
  const [glow, setGlow] = useState<[string, string, 0 | 1]>(['transparent', 'transparent', 0])
  useEffect(() => {
    if (!rec) return
    let alive = true
    // 封面图可能还没加载好：稍等一下再取色
    const t = setTimeout(() => {
      coverColor(rec.hash, rec.hasCover).then(c => {
        if (!alive) return
        setGlow(([a, b, top]) => ((top === 0 ? a : b) === c ? [a, b, top] : top === 0 ? [a, c, 1] : [c, b, 0]))
      })
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [rec?.hash, rec?.coverRev, rec?.hasCover])

  return (
    <div className="carousel-wrap">
      {backdropOn &&
        backdropHost &&
        createPortal(
          <div className="carousel-backdrop" aria-hidden>
            <i style={{ backgroundImage: backdrop[0] ? `url(${backdrop[0]})` : undefined, opacity: backdrop[2] === 0 && backdrop[0] ? 1 : 0 }} />
            <i style={{ backgroundImage: backdrop[1] ? `url(${backdrop[1]})` : undefined, opacity: backdrop[2] === 1 && backdrop[1] ? 1 : 0 }} />
          </div>,
          backdropHost,
        )}
      <div className="carousel-glow" aria-hidden hidden={backdropOn}>
        <i style={{ background: `radial-gradient(closest-side, ${glow[0]}, transparent)`, opacity: glow[2] === 0 ? 1 : 0 }} />
        <i style={{ background: `radial-gradient(closest-side, ${glow[1]}, transparent)`, opacity: glow[2] === 1 ? 1 : 0 }} />
      </div>
      <div className={`carousel ${SDA ? 'sda' : ''}`} ref={ref} onScroll={onScroll}>
        {items}
      </div>

      {books.length > 1 && (
        <>
          <button className="carousel-arrow left" aria-label={tr('上一本')} disabled={active === 0} onClick={() => goTo(active - 1)}>
            <IconChevronL />
          </button>
          <button className="carousel-arrow right" aria-label={tr('下一本')} disabled={active === books.length - 1} onClick={() => goTo(active + 1)}>
            <IconChevronR />
          </button>
        </>
      )}

      {rec && (
        <div className="carousel-info">
          {/* 换书时这一块整体轻轻亮起来一下（不位移、不先消失），所以用书的标识做 key */}
          <div className="carousel-info-in" key={rec.hash}>
            <h2 className="serif">{rec.title}</h2>
            <div className="carousel-meta">
              {rec.author || (rec.format === 'txt' ? 'TXT' : tr('佚名'))}
              {readMs > 60_000 && ` · ${tr('已读 {time}', { time: formatDuration(readMs) })}`}
            </div>
            <div className="carousel-progress">
              <div className="progress-line">
                <i style={{ width: `${pct}%` }} />
              </div>
              <span>{rec.progress ? `${pct}%` : tr('未读')}</span>
            </div>
            <div className="carousel-chapter">{rec.progress?.chapter ? tr('读到 {chapter}', { chapter: rec.progress.chapter }) : ' '}</div>
          </div>
          {!selecting && (
            <button className="btn primary carousel-open" onClick={() => onOpen(rec)}>
              {rec.progress ? tr('继续阅读') : tr('开始阅读')}
            </button>
          )}
        </div>
      )}

      {/* 位置指示：书不多时用小圆点（当前那本拉长成胶囊），多了用细进度条 */}
      {books.length > 1 &&
        (books.length <= 20 ? (
          <div className="carousel-dots" role="tablist" aria-label={tr('切换书')}>
            {books.map((b, i) => (
              <button key={b.hash} role="tab" aria-selected={i === active} aria-label={b.title} className={i === active ? 'on' : ''} onClick={() => goTo(i)} />
            ))}
          </div>
        ) : (
          <div className="carousel-track" aria-label={tr('第 {i} 本，共 {n} 本', { i: active + 1, n: books.length })}>
            <i style={{ width: `${((active + 1) / books.length) * 100}%` }} />
            <span>
              {active + 1} / {books.length}
            </span>
          </div>
        ))}
    </div>
  )
}

interface ItemCallbacks {
  onOpen: (rec: BookRecord) => void
  onToggle: (rec: BookRecord) => void
  onLongPress: (rec: BookRecord) => void
  onMenu: (rec: BookRecord, x: number, y: number) => void
  goTo: (i: number) => void
  selecting: boolean
}

const CarouselItem = memo(function CarouselItem({
  rec,
  index,
  selecting,
  selected,
  cb,
  activeRef,
}: {
  rec: BookRecord
  index: number
  selecting: boolean
  selected: boolean
  cb: React.MutableRefObject<ItemCallbacks>
  activeRef: React.MutableRefObject<number>
}) {
  const press = useMemo(() => longPress(() => cb.current.onLongPress(rec)), [cb, rec])
  return (
    <button
      data-book={rec.hash}
      className="carousel-item"
      onClick={e => {
        if (consumeLongPress()) return
        const c = cb.current
        if (c.selecting) return c.onToggle(rec)
        if (index !== activeRef.current) return c.goTo(index)
        c.onOpen(rec)
        e.currentTarget.blur()
      }}
      onContextMenu={e => {
        e.preventDefault()
        // 手指长按也会触发 contextmenu：交给上面的长按计时处理，避免弹两次
        if ((e.nativeEvent as PointerEvent).pointerType === 'touch') return
        cb.current.onMenu(rec, e.clientX, e.clientY)
      }}
      {...press}
    >
      <BookCover rec={rec} large selecting={selecting} selected={selected} />
    </button>
  )
})
