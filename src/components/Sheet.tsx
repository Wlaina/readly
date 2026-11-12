import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { motionScale } from '../lib/motion'

/** 这些控件自己要响应拖动（进度滑块、目录滚动条等），在它们上面起手不算拖动面板 */
const OWN_DRAG = 'input[type="range"], .toc-rail, .no-sheet-drag'

/** 从按钮上“拉出”面板：按下时手指的位置和指针编号 */
export interface SheetPull {
  x: number
  id: number
}

/**
 * 统一的面板：底部面板从下方滑入、往下滑出；侧边面板（side）从左侧滑入、往左滑出。
 * - 手指可以直接把面板拖走：拖过三成或甩得够快就关闭，否则弹回原位。
 *   松手的那一刻就顺着手的速度滑出去（不等关闭流程绕一圈回来，所以不会顿一下）。
 * - pull：侧边面板跟着手指从屏幕左边被“拉出来”（阅读页长按目录按钮往右拖）。
 * 面板里的内容还能滚动时（没滚到顶）优先滚动内容。
 */
export default function Sheet({
  side = false,
  className = '',
  onClose,
  pull,
  children,
  ...rest
}: {
  side?: boolean
  className?: string
  onClose: () => void
  pull?: SheetPull | null
  children: ReactNode
} & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  // 被拉出来的面板不播放入场动画（由手指带出来）；这个状态在面板存在期间保持不变，免得中途又补播一次
  const [pulled] = useState(() => !!pull && side)

  /** 顺着当前速度把面板送出屏幕，然后关闭 */
  const flingOut = (el: HTMLDivElement, dist: number, speed: number) => {
    const size = side ? el.offsetWidth : el.offsetHeight
    const rest = Math.max(0, size - dist)
    const ms = Math.round(Math.min(260, Math.max(120, rest / Math.max(speed, 0.9))) * motionScale())
    // data-out：告诉样式表这个面板已经在自己滑出去了，退场动画别再从头播一次
    el.dataset.out = '1'
    el.style.transition = `transform ${ms}ms cubic-bezier(.3, .55, .35, 1)`
    el.style.transform = side ? 'translate3d(-104%, 0, 0)' : 'translate3d(0, calc(100% + 28px), 0)'
    close.current()
  }

  /** 弹回原位 */
  const settleBack = (el: HTMLDivElement) => {
    el.style.transition = `transform ${Math.round(300 * motionScale())}ms cubic-bezier(.2, .9, .25, 1)`
    el.style.transform = ''
    const done = () => {
      el.style.transition = ''
      el.removeEventListener('transitionend', done)
    }
    el.addEventListener('transitionend', done)
    // 界面在后台时过渡不会结束、也收不到 transitionend：到点也清理
    setTimeout(done, 400)
  }

  // ---------- 从按钮上拉出来 ----------
  useEffect(() => {
    const el = ref.current
    if (!el || !pulled || !pull) return
    const w = el.offsetWidth
    let x = -w
    let v = 0
    let lastX = pull.x
    let lastT = performance.now()
    el.style.transition = 'none'
    el.style.transform = `translate3d(${x}px, 0, 0)`
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pull.id) return
      // 面板右边缘跟着手指走（起手时露出一小截，告诉你“抓住了”）
      x = Math.min(0, Math.max(-w, -w + 28 + (e.clientX - pull.x) * 1.05))
      el.style.transform = `translate3d(${x}px, 0, 0)`
      const dt = e.timeStamp - lastT
      if (dt > 0) {
        v = 0.7 * ((e.clientX - lastX) / dt) + 0.3 * v
        lastX = e.clientX
        lastT = e.timeStamp
      }
    }
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pull.id) return
      stop()
      const shown = w + x
      if (e.type === 'pointerup' && (shown > w * 0.38 || (v > 0.35 && shown > 40))) {
        // 打开：顺着手速滑到位
        const ms = Math.round(Math.min(280, Math.max(140, -x / Math.max(v, 0.8))) * motionScale())
        el.style.transition = `transform ${ms}ms cubic-bezier(.2, .9, .25, 1)`
        el.style.transform = 'translate3d(0, 0, 0)'
        const done = () => {
          el.style.transition = ''
          el.style.transform = ''
          el.removeEventListener('transitionend', done)
        }
        el.addEventListener('transitionend', done)
        setTimeout(done, ms + 120)
      } else flingOut(el, shown, 1)
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return stop
    // 只在面板出现时接管一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- 拖走关闭 ----------
  useEffect(() => {
    const el = ref.current
    if (!el) return
    /** 0 还没判定方向；1 正在拖面板；2 这次触摸与面板无关 */
    let mode: 0 | 1 | 2 = 2
    let sx = 0
    let sy = 0
    let blocked = false
    let d = 0
    let v = 0
    let lastD = 0
    let lastT = 0

    const onStart = (e: TouchEvent) => {
      const t = e.target as Element | null
      if (e.touches.length !== 1 || !t || el.closest('.closing') || el.dataset.out || t.closest?.(OWN_DRAG)) {
        mode = 2
        return
      }
      mode = 0
      sx = e.touches[0].clientX
      sy = e.touches[0].clientY
      d = v = lastD = 0
      lastT = e.timeStamp
      // 手指下面的内容自己还能往这个方向滚：先滚内容，不拖面板
      blocked = false
      for (let n: Element | null = t; n && n !== el.parentElement; n = n.parentElement) {
        if (side) {
          if (n.scrollWidth > n.clientWidth + 1 && n.scrollLeft < n.scrollWidth - n.clientWidth - 1 && /auto|scroll/.test(getComputedStyle(n).overflowX)) blocked = true
        } else if (n.scrollTop > 0) blocked = true
      }
    }

    const onMove = (e: TouchEvent) => {
      if (mode === 2 || e.touches.length !== 1) return
      const dx = e.touches[0].clientX - sx
      const dy = e.touches[0].clientY - sy
      if (mode === 0) {
        const along = side ? -dx : dy
        const across = side ? Math.abs(dy) : Math.abs(dx)
        if (along > 8 && along > across * 1.2 && !blocked) {
          mode = 1
          el.style.transition = 'none'
          // 从这一刻的位置开始跟手，不跳
          sx = e.touches[0].clientX
          sy = e.touches[0].clientY
          lastT = e.timeStamp
          return
        } else if (across > 8 || along < -8) {
          mode = 2
          return
        } else return
      }
      if (e.cancelable) e.preventDefault()
      const raw = side ? dx : dy
      // 往关闭方向跟手；往反方向拉只给一点阻尼
      d = side ? (raw < 0 ? raw : raw * 0.12) : raw > 0 ? raw : raw * 0.12
      el.style.transform = side ? `translate3d(${d}px, 0, 0)` : `translate3d(0, ${d}px, 0)`
      const dt = e.timeStamp - lastT
      if (dt > 0) {
        v = 0.7 * ((d - lastD) / dt) + 0.3 * v
        lastD = d
        lastT = e.timeStamp
      }
    }

    const onEnd = () => {
      if (mode !== 1) {
        mode = 2
        return
      }
      mode = 2
      const size = side ? el.offsetWidth : el.offsetHeight
      const dist = side ? -d : d
      const speed = side ? -v : v // 往关闭方向的速度，px/ms
      if (dist > size * 0.3 || (speed > 0.45 && dist > 20)) flingOut(el, dist, speed)
      else settleBack(el)
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side])

  return (
    <div ref={ref} className={`sheet glass ${side ? 'side' : ''} ${pulled ? 'pulled' : ''} ${className}`} {...rest}>
      {!side && <div className="sheet-grip" />}
      {children}
    </div>
  )
}
