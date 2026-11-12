import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { tr } from '../lib/i18n'

export interface TocItem {
  label: string
  href: string
  subitems?: TocItem[] | null
}

interface Node {
  /** 在整棵目录里的唯一标识（按位置编号，如 "3" 或 "3.12"） */
  id: string
  label: string
  href: string
  depth: number
  /** 有下级的条目是“卷”：点它是展开/收起，不是跳转 */
  group: boolean
  /** 所有上级卷的 id */
  parents: string[]
  /** 这一卷里（含各级下级）一共有多少章 */
  count: number
}

function build(items: TocItem[], depth = 0, prefix = '', parents: string[] = [], out: Node[] = []) {
  items.forEach((it, i) => {
    const id = prefix ? `${prefix}.${i}` : String(i)
    const group = !!it.subitems?.length
    const node: Node = { id, label: it.label?.trim() || tr('（无标题）'), href: it.href, depth, group, parents, count: 0 }
    out.push(node)
    if (group) {
      const before = out.length
      build(it.subitems!, depth + 1, id, [...parents, id], out)
      node.count = out.slice(before).filter(n => !n.group).length
    }
  })
  return out
}

const THUMB = 44

/**
 * 目录：
 * - 有分卷的书：卷可以展开/收起（点卷名只展开，不跳转）；打开时自动展开正在读的那一卷
 * - 右侧可拖动的进度条上标出每一卷的位置（小刻度），正在读的那一卷高亮，“上次读到”是圆点
 * - 没有分卷的书就是一张平铺的列表（数千章也流畅）
 */
export default function TocPanel({
  toc,
  current,
  fraction,
  onGo,
}: {
  toc: TocItem[]
  current: string
  fraction: number
  onGo: (href: string) => void
}) {
  const nodes = useMemo(() => build(toc), [toc])
  const hasGroups = useMemo(() => nodes.some(n => n.group), [nodes])
  // 卷和它的第一章常常指向同一个位置：优先认章节，高亮才会落在章节那一行
  const currentNode = useMemo(() => nodes.find(n => n.href === current && !n.group) ?? nodes.find(n => n.href === current), [nodes, current])
  /** 正在读的位置所在的最外层卷 */
  const currentVolume = currentNode ? (currentNode.parents[0] ?? (currentNode.group ? currentNode.id : undefined)) : undefined

  // 展开了哪些卷：一开始只展开正在读的那一卷（以及它的上级）
  const [open, setOpen] = useState<Set<string>>(() => new Set(currentNode ? [...currentNode.parents, ...(currentNode.group ? [currentNode.id] : [])] : []))
  // 读到了另一卷（翻页跨卷后再打开目录）：把新的那一卷也展开
  const seen = useRef(currentNode?.id)
  useEffect(() => {
    if (!currentNode || seen.current === currentNode.id) return
    seen.current = currentNode.id
    setOpen(s => (currentNode.parents.every(p => s.has(p)) ? s : new Set([...s, ...currentNode.parents])))
  }, [currentNode])

  const rows = useMemo(() => nodes.filter(n => n.parents.every(p => open.has(p))), [nodes, open])
  const listRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(0)
  const [scrollable, setScrollable] = useState(false)
  const [markRatio, setMarkRatio] = useState<number | null>(null)
  /** 每一卷在进度条上的位置 */
  const [ticks, setTicks] = useState<{ id: string; at: number; label: string }[]>([])
  const [bubble, setBubble] = useState<string | null>(null)

  const measure = useCallback(() => {
    const el = listRef.current
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    setScrollable(max > 8)
    setRatio(max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0)
    const spot = (row: HTMLElement) => Math.min(1, Math.max(0, (row.offsetTop - el.clientHeight / 2 + row.offsetHeight / 2) / max))
    const cur = el.querySelector<HTMLElement>('.toc-item.current')
    setMarkRatio(cur && max > 0 ? spot(cur) : null)
    if (max > 0) {
      const next = Array.from(el.querySelectorAll<HTMLElement>('.toc-item.volume[data-depth="0"]'), row => ({ id: row.dataset.id!, at: spot(row), label: row.dataset.label ?? '' }))
      setTicks(prev => (prev.length === next.length && prev.every((t, i) => t.id === next[i].id && Math.abs(t.at - next[i].at) < 0.002) ? prev : next))
    } else setTicks(t => (t.length ? [] : t))
  }, [])

  // 打开时把上次读到的章节滚到中间（只在打开、或读到的章节变了的时候；展开/收起别的卷时不乱跳）
  const centered = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = listRef.current
    const cur = el?.querySelector<HTMLElement>('.toc-item.current')
    if (el && cur && centered.current !== current) {
      centered.current = current
      el.scrollTop = cur.offsetTop - el.clientHeight / 2 + cur.offsetHeight / 2
    }
    measure()
  }, [measure, current, rows])

  useEffect(() => {
    const ro = new ResizeObserver(measure)
    if (listRef.current) ro.observe(listRef.current)
    return () => ro.disconnect()
  }, [measure])

  /** 展开/收起一卷；收起时保持这一卷的标题在原来的位置，不让列表跳走 */
  const toggle = (id: string, row: HTMLElement) => {
    const el = listRef.current
    const before = row.getBoundingClientRect().top
    setOpen(s => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
    requestAnimationFrame(() => {
      const again = el?.querySelector<HTMLElement>(`.toc-item[data-id="${id}"]`)
      if (el && again) el.scrollTop += again.getBoundingClientRect().top - before
    })
  }

  const scrollToRatio = (clientY: number) => {
    const rail = railRef.current
    const el = listRef.current
    if (!rail || !el) return
    const rect = rail.getBoundingClientRect()
    const r = Math.min(1, Math.max(0, (clientY - rect.top - THUMB / 2) / (rect.height - THUMB)))
    el.scrollTop = r * (el.scrollHeight - el.clientHeight)
    // 气泡里显示滚到了哪一行（有分卷时带上卷名）
    const mid = el.scrollTop + el.clientHeight / 2
    let hit: HTMLElement | null = null
    for (const row of el.querySelectorAll<HTMLElement>('.toc-item')) {
      if (row.offsetTop > mid) break
      hit = row
    }
    setBubble(hit?.dataset.label ?? null)
  }

  return (
    <div className="toc-wrap">
      <div className="toc-list" ref={listRef} onScroll={measure}>
        {rows.map(n => {
          const isCurrent = n.id === currentNode?.id
          const inPath = !!currentNode && (currentNode.parents.includes(n.id) || isCurrent)
          const expanded = open.has(n.id)
          return (
            <button
              key={n.id}
              data-id={n.id}
              data-depth={n.depth}
              data-label={n.label}
              className={`toc-item ${n.group ? 'volume' : ''} ${isCurrent ? 'current' : ''} ${n.group && inPath ? 'reading' : ''}`}
              style={{ paddingLeft: 10 + n.depth * 16 }}
              aria-expanded={n.group ? expanded : undefined}
              onClick={e => (n.group ? toggle(n.id, e.currentTarget) : onGo(n.href))}
            >
              {n.group && (
                <svg className={`toc-caret ${expanded ? 'open' : ''}`} viewBox="0 0 24 24" aria-hidden>
                  <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              <span className="toc-label">{n.label}</span>
              {n.group && !isCurrent && <span className="toc-count">{n.count}</span>}
              {isCurrent && <span className="toc-here" title={tr('上次读到')}>{(fraction * 100).toFixed(1)}%</span>}
            </button>
          )
        })}
      </div>

      {scrollable && (
        <div
          ref={railRef}
          className={`toc-rail ${bubble !== null ? 'dragging' : ''}`}
          onPointerDown={e => {
            e.currentTarget.setPointerCapture(e.pointerId)
            scrollToRatio(e.clientY)
          }}
          onPointerMove={e => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) scrollToRatio(e.clientY)
          }}
          onPointerUp={() => setBubble(null)}
          onPointerCancel={() => setBubble(null)}
        >
          {/* 每一卷一个小刻度；正在读的那一卷更亮更长 */}
          {hasGroups &&
            ticks.map(t => (
              <i key={t.id} className={`toc-tick ${t.id === currentVolume ? 'on' : ''}`} title={t.label} style={{ top: `calc(${t.at} * (100% - ${THUMB}px) + ${THUMB / 2}px)` }} />
            ))}
          {markRatio !== null && (
            <i
              className="toc-mark"
              title={tr('上次读到的章节')}
              style={{ top: `calc(${markRatio} * (100% - ${THUMB}px) + ${THUMB / 2}px)` }}
            />
          )}
          <b className="toc-thumb" style={{ top: `calc(${ratio} * (100% - ${THUMB}px))` }}>
            {bubble !== null && <span className="toc-bubble">{bubble}</span>}
          </b>
        </div>
      )}
    </div>
  )
}
