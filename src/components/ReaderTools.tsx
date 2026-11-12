/**
 * 阅读器里的工具：书内搜索、划词高亮/笔记的弹出菜单、笔记编辑框、笔记列表。
 * 渲染引擎（foliate-js）负责搜索与高亮的绘制，这里只负责界面。
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import type { Annotation, HighlightColor } from '../lib/types'
import { tr } from '../lib/i18n'
import { IconCheck, IconNote, IconSearch, IconTrash, IconX } from './icons'
import { buildSearchRegex } from '../lib/fuzzy'
import Sheet from './Sheet'

export const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: '#f2c94c',
  orange: '#e8875e',
  green: '#7fb069',
  blue: '#5b9bd5',
  pink: '#e58fb0',
}
const COLOR_ORDER: HighlightColor[] = ['yellow', 'orange', 'green', 'blue', 'pink']

/* ---------------- 书内搜索 ---------------- */

export interface SearchHit {
  cfi: string
  pre: string
  match: string
  post: string
}
export interface SearchGroup {
  label: string
  hits: SearchHit[]
}
/** 搜索状态放在阅读器里：关掉面板再打开，上次的结果还在 */
export interface SearchState {
  query: string
  groups: SearchGroup[]
  done: boolean
  progress: number
}
export const emptySearch = (): SearchState => ({ query: '', groups: [], done: true, progress: 0 })

export function SearchSheet({
  viewRef,
  state,
  setState,
  onGo,
  onClose,
}: {
  viewRef: React.RefObject<any>
  state: SearchState
  setState: (s: SearchState) => void
  onGo: (cfi: string) => void
  onClose: () => void
}) {
  const [input, setInput] = useState(state.query)
  const run = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    // 电脑上打开就能直接输入；手机上不自动弹键盘，避免挡住结果
    if (!matchMedia('(pointer: coarse)').matches) inputRef.current?.focus()
  }, [])

  const search = async (q: string) => {
    const view = viewRef.current
    const query = q.trim()
    const id = ++run.current
    if (!view || !query) {
      view?.clearSearch?.()
      setState(emptySearch())
      return
    }
    let groups: SearchGroup[] = []
    setState({ query, groups, done: false, progress: 0 })
    try {
      // 模糊匹配：不区分大小写与全角半角，字之间夹着标点空格也算，空格分开的多个词在附近出现即可
      const fuzzy = buildSearchRegex(query)
      const opts = fuzzy ? { query: fuzzy, mode: 'regex', matchCase: false } : { query }
      for await (const r of view.search(opts)) {
        if (id !== run.current) return // 又发起了新的搜索
        if (r === 'done') break
        if (typeof r.progress === 'number') {
          setState({ query, groups, done: false, progress: r.progress })
          continue
        }
        if (r.subitems) {
          const hits = r.subitems.map((s: any) => ({
            cfi: s.cfi,
            pre: s.excerpt?.pre ?? '',
            match: s.excerpt?.match ?? '',
            post: s.excerpt?.post ?? '',
          }))
          groups = [...groups, { label: r.label || tr('（无标题）'), hits }]
          setState({ query, groups, done: false, progress: (r.index + 1) / (view.book?.sections?.length || 1) })
        }
      }
    } catch (e) {
      console.error('搜索失败', e)
    }
    if (id === run.current) setState({ query, groups, done: true, progress: 1 })
  }

  const total = state.groups.reduce((a, g) => a + g.hits.length, 0)
  return (
    <Sheet side className="search-sheet" onClose={onClose}>
      <form
        className="search-box"
        onSubmit={e => {
          e.preventDefault()
          search(input)
        }}
      >
        <IconSearch />
        <input
          ref={inputRef}
          className="field"
          value={input}
          placeholder={tr('在书中搜索')}
          enterKeyHint="search"
          onChange={e => setInput(e.target.value)}
        />
        {input && (
          <button
            type="button"
            className="icon-btn"
            aria-label={tr('清除')}
            onClick={() => {
              setInput('')
              search('')
              inputRef.current?.focus()
            }}
          >
            <IconX />
          </button>
        )}
      </form>
      {state.query && (
        <div className="search-meta">
          {state.done ? tr('共 {n} 处', { n: total }) : tr('搜索中… {pct}%', { pct: Math.round(state.progress * 100) })}
          {!state.done && (
            <div className="progress-line">
              <i style={{ width: `${state.progress * 100}%` }} />
            </div>
          )}
        </div>
      )}
      <div className="toc-list search-list">
        {state.groups.map((g, gi) => (
          <div key={gi} className="search-group">
            <div className="search-chapter">{g.label}</div>
            {g.hits.map(h => (
              <button key={h.cfi} className="search-hit" onClick={() => onGo(h.cfi)}>
                {h.pre}
                <mark>{h.match}</mark>
                {h.post}
              </button>
            ))}
          </div>
        ))}
        {state.query && state.done && !total && <p className="hist-empty">{tr('没有找到“{q}”', { q: state.query })}</p>}
        {!state.query && <p className="hist-empty">{tr('不区分大小写和标点；用空格分开多个词，可以找到它们在附近一起出现的地方')}</p>}
      </div>
    </Sheet>
  )
}

/* ---------------- 划词菜单 ---------------- */

export interface SelectionInfo {
  cfi: string
  text: string
  fraction: number
  chapter: string
  /** 选区在窗口中的位置 */
  rect: { left: number; top: number; bottom: number; width: number }
  /** 点到的是已有的高亮 */
  existing?: Annotation
}

export function SelectionMenu({
  sel,
  onColor,
  onNote,
  onCopy,
  onDelete,
}: {
  sel: SelectionInfo
  onColor: (c: HighlightColor) => void
  onNote: () => void
  onCopy: () => void
  onDelete?: () => void
}) {
  const W = 300
  const left = Math.max(10, Math.min(innerWidth - W - 10, sel.rect.left + sel.rect.width / 2 - W / 2))
  // 放在选区下方（安卓系统的复制菜单一般在上方，避免互相遮挡）；下方放不下时放上方
  const below = sel.rect.bottom + 12
  const top = below + 56 > innerHeight - 10 ? Math.max(10, sel.rect.top - 64) : below
  const current = sel.existing?.color
  return (
    <div className="sel-menu glass" style={{ left, top, width: W }} onPointerDown={e => e.stopPropagation()}>
      {COLOR_ORDER.map(c => (
        <button key={c} className={`sel-color ${current === c ? 'on' : ''}`} style={{ background: HIGHLIGHT_COLORS[c] }} aria-label={c} onClick={() => onColor(c)}>
          {current === c && <IconCheck />}
        </button>
      ))}
      <span className="sel-sep" />
      <button className="icon-btn" aria-label={tr('笔记')} title={tr('笔记')} onClick={onNote}>
        <IconNote />
      </button>
      <button className="sel-text" onClick={onCopy}>
        {tr('复制')}
      </button>
      {onDelete && (
        <button className="icon-btn danger" aria-label={tr('删除高亮')} title={tr('删除高亮')} onClick={onDelete}>
          <IconTrash />
        </button>
      )}
    </div>
  )
}

/* ---------------- 笔记编辑 ---------------- */

export function NoteDialog({ text, note, onSave, onClose }: { text: string; note: string; onSave: (note: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(note)
  return (
    <>
      <div className="scrim dim" style={{ zIndex: 70 }} onClick={onClose} />
      <div className="dialog glass note-dialog" role="dialog" aria-label={tr('笔记')}>
        <blockquote className="note-quote serif">{text}</blockquote>
        <textarea
          className="field"
          autoFocus
          rows={5}
          value={value}
          placeholder={tr('写下你的想法…')}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSave(value.trim())
            if (e.key === 'Escape') onClose()
          }}
        />
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            {tr('取消')}
          </button>
          <button className="btn primary" onClick={() => onSave(value.trim())}>
            {tr('保存')}
          </button>
        </div>
      </div>
    </>
  )
}

/* ---------------- 笔记列表（目录面板里的一个标签） ---------------- */

export function NotesList({ hash, onGo, onEdit }: { hash: string; onGo: (cfi: string) => void; onEdit: (a: Annotation) => void }) {
  const list = useStore(s => s.library.find(b => b.hash === hash)?.annotations)?.filter(a => !a.deleted) ?? []
  if (!list.length) return <p style={{ color: 'var(--muted)' }}>{tr('选中文字即可高亮或写笔记')}</p>
  return (
    <div className="toc-list">
      {list.map(a => (
        <div key={a.id} className="note-item" style={{ '--hl': HIGHLIGHT_COLORS[a.color] } as React.CSSProperties}>
          <button className="go" onClick={() => onGo(a.cfi)}>
            <span className="note-text">{a.text}</span>
            {a.note && <span className="note-body">{a.note}</span>}
            <span className="note-meta">
              {a.chapter ? `${a.chapter} · ` : ''}
              {(a.fraction * 100).toFixed(1)}%
            </span>
          </button>
          <div className="note-actions">
            <button className="icon-btn" aria-label={tr('笔记')} onClick={() => onEdit(a)}>
              <IconNote />
            </button>
            <button className="icon-btn" aria-label={tr('删除高亮')} onClick={() => useStore.getState().removeAnnotation(hash, a.id)}>
              <IconTrash />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
