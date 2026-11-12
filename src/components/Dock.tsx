import { useRef, useState } from 'react'
import { haptic } from '../lib/native'

/** 滑动时在一项上停留这么久才真正切页：快速划过的中间页不再一个个加载 */
const COMMIT_MS = 110

export interface DockTab<T extends string> {
  id: T
  label: string
  icon: (p: React.SVGProps<SVGSVGElement>) => React.ReactElement
}

const ITEM_W = 76 // 底部横排时每项宽度
const ITEM_H = 64 // 电脑左侧竖排时每项高度
const PAD = 6
const HOLD_MS = 150

/**
 * 导航条：点按切换；长按后滑动，滑到哪一项就立刻切到哪一页，松手即结束。
 * side=true 时为电脑端左侧竖排。
 */
export default function Dock<T extends string>({
  tabs,
  tab,
  onChange,
  side = false,
  extra,
  badges,
}: {
  /** 角标数字，例如同步页显示正在进行的任务数 */
  badges?: Partial<Record<T, number>>
  tabs: DockTab<T>[]
  tab: T
  onChange: (t: T) => void
  side?: boolean
  /** 电脑端侧栏底部的附加按钮（如全屏） */
  extra?: React.ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  const [scrub, setScrub] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const scrubbing = useRef(false)
  const lastIndex = useRef(-1)
  const wheelAcc = useRef(0)
  const wheelAt = useRef(0)
  // 滑动中高亮胶囊立刻跟手，页面稍后再切
  const [hoverIdx, setHoverIdx] = useState(-1)
  const commit = useRef<ReturnType<typeof setTimeout>>()
  const pending = useRef<T | null>(null)
  const flush = () => {
    clearTimeout(commit.current)
    if (pending.current != null) onChange(pending.current)
    pending.current = null
  }

  const indexAt = (x: number, y: number) => {
    const r = ref.current!.getBoundingClientRect()
    const i = side ? Math.floor((y - r.top - PAD) / ITEM_H) : Math.floor((x - r.left - PAD) / ITEM_W)
    return Math.min(tabs.length - 1, Math.max(0, i))
  }
  /** 滑到新的一项：震动一下并立刻切页 */
  const go = (i: number) => {
    if (i === lastIndex.current) return
    lastIndex.current = i
    haptic(scrubbing.current ? 6 : 12)
    if (!scrubbing.current) {
      onChange(tabs[i].id)
      return
    }
    setHoverIdx(i)
    pending.current = tabs[i].id
    clearTimeout(commit.current)
    commit.current = setTimeout(flush, COMMIT_MS)
  }
  const end = () => {
    clearTimeout(timer.current)
    flush()
    setHoverIdx(-1)
    start.current = null
    scrubbing.current = false
    lastIndex.current = -1
    setScrub(false)
  }

  const current = tabs.findIndex(t => t.id === tab)
  const shown = scrub && hoverIdx >= 0 ? hoverIdx : current

  return (
    <nav
      ref={ref}
      className={`dock glass ${side ? 'side' : ''} ${scrub ? 'scrubbing' : ''}`}
      style={{ '--i': shown } as React.CSSProperties}
      onPointerDown={e => {
        if (e.button !== 0 || (e.target as Element).closest('.dock-extra')) return
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* 个别环境不支持捕获，不影响点按 */
        }
        start.current = { x: e.clientX, y: e.clientY, moved: false }
        const { clientX: x, clientY: y } = e
        timer.current = setTimeout(() => {
          scrubbing.current = true
          setScrub(true)
          lastIndex.current = current
          haptic(12)
          go(indexAt(x, y))
        }, HOLD_MS)
      }}
      onPointerMove={e => {
        const s = start.current
        if (!s) return
        if (scrubbing.current) return go(indexAt(e.clientX, e.clientY))
        // 长按判定前就移动了：直接进入滑动模式（按住拖动也能切换）
        if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) {
          s.moved = true
          clearTimeout(timer.current)
          scrubbing.current = true
          setScrub(true)
          lastIndex.current = current
          go(indexAt(e.clientX, e.clientY))
        }
      }}
      onPointerUp={e => {
        const s = start.current
        if (s && !scrubbing.current && !s.moved) go(indexAt(e.clientX, e.clientY))
        end()
      }}
      onPointerCancel={end}
      onContextMenu={e => e.preventDefault()}
      onWheel={e => {
        // 鼠标放在导航栏上滚动滚轮：逐个切换页面（触控板的轻微滑动累积到一定量才切）
        const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
        wheelAcc.current += d
        const now = Date.now()
        if (Math.abs(wheelAcc.current) < 40 || now - wheelAt.current < 220) return
        const i = Math.min(tabs.length - 1, Math.max(0, current + (wheelAcc.current > 0 ? 1 : -1)))
        wheelAcc.current = 0
        wheelAt.current = now
        if (i !== current) {
          haptic(6)
          onChange(tabs[i].id)
        }
      }}
    >
      <span className="dock-pill" />
      {tabs.map((t, i) => (
        <button
          key={t.id}
          className={i === shown ? 'active' : ''}
          aria-current={t.id === tab ? 'page' : undefined}
          // 鼠标/触摸由上面的指针事件处理；这里只响应键盘（detail 为 0）
          onClick={e => e.detail === 0 && onChange(t.id)}
        >
          <t.icon />
          <span className="dock-label">{t.label}</span>
          {!!badges?.[t.id] && <span className="badge-dot">{badges[t.id]}</span>}
        </button>
      ))}
      {side && extra && <div className="dock-extra">{extra}</div>}
    </nav>
  )
}
