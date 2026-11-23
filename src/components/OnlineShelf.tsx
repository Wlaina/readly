/**
 * 在线书架：收藏的在线书（不下载，直接在线读）。
 * 显示封面、书名、读到哪一章、新章节角标；可以继续阅读、检查更新（单本 / 全部）、移出书架。
 *
 * <OnlineShelf />                       点“继续阅读”默认直接打开在线阅读（页面里要放 <OnlineReaderHost />）
 * <OnlineShelf onOpen={b => …} />        自己处理打开（回调在点击事件里同步调用，可以直接 pushOverlay）
 */
import { IconSync, IconTrash, IconChevronR } from './icons'
import { tr } from '../lib/i18n'
import { useStore } from '../lib/store'
import { askConfirm } from '../lib/dialog'
import {
  chapterCount,
  checkAllOnlineUpdates,
  checkOnlineUpdate,
  flatIndex,
  progressLabel,
  removeFromOnlineShelf,
  sourceOf,
  useOnline,
  useOnlineImage,
  useOnlineShelf,
  type OnlineBook,
} from '../lib/sources/online'
import { openOnlineInReader } from '../lib/sources/onlinebook'
import '../styles-online.css'

export interface OnlineShelfProps {
  /** 点“继续阅读” / 点卡片；不传则直接打开在线阅读 */
  onOpen?: (book: OnlineBook) => void
  /** 点封面 / 书名看详情（例如打开书库的 BookSheet）；不传则同 onOpen */
  onDetails?: (book: OnlineBook) => void
  /** 书架为空时显示的提示 */
  emptyText?: string
  className?: string
}

const sourceName = (id: string) => {
  try {
    return tr(sourceOf(id).name)
  } catch {
    return id
  }
}

function ago(ts: number) {
  if (!ts) return ''
  const m = Math.round((Date.now() - ts) / 60_000)
  if (m < 1) return tr('刚刚')
  if (m < 60) return tr('{n} 分钟前', { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return tr('{n} 小时前', { n: h })
  return tr('{n} 天前', { n: Math.round(h / 24) })
}

export default function OnlineShelf({ onOpen, onDetails, emptyText, className = '' }: OnlineShelfProps) {
  const books = useOnlineShelf()
  const loaded = useOnline(s => s.loaded)
  const all = useOnline(s => s.checkAll)
  const showToast = useStore(s => s.showToast)
  const open = (b: OnlineBook) => (onOpen ? onOpen(b) : openOnlineInReader(b))

  const checkAll = async () => {
    const r = await checkAllOnlineUpdates()
    if (r.updated) showToast(tr('{n} 本书有更新，共 {c} 章新内容', { n: r.updated, c: r.added }) + (r.failed ? tr('（{f} 本检查失败）', { f: r.failed }) : ''))
    else if (r.failed) showToast(tr('没有发现更新（{f} 本检查失败）', { f: r.failed }))
    else showToast(tr('都是最新的'))
  }

  if (!loaded) return <div className={`ol-shelf ${className}`}><div className="src-state">{tr('正在读取在线书架…')}</div></div>

  return (
    <div className={`ol-shelf ${className}`}>
      {books.length ? (
        <>
          <div className="ol-head">
            <span className="muted">{tr('{n} 本在线书', { n: books.length })}</span>
            <button className="btn ghost" onClick={checkAll} disabled={!!all}>
              <IconSync className={all ? 'ol-spin' : ''} />
              {all ? tr('检查中 {done} / {total}', { done: all.done, total: all.total }) : tr('全部检查更新')}
            </button>
          </div>
          <div className="ol-list">
            {books.map(b => (
              <ShelfCard key={b.key} book={b} onOpen={() => open(b)} onDetails={() => (onDetails ? onDetails(b) : open(b))} />
            ))}
          </div>
        </>
      ) : (
        <div className="src-state">{emptyText ?? tr('在线书架还是空的。在书籍详情里点“加入在线书架”，不用下载就能追更。')}</div>
      )}
    </div>
  )
}

function ShelfCard({ book, onOpen, onDetails }: { book: OnlineBook; onOpen: () => void; onDetails: () => void }) {
  const cover = useOnlineImage(book.cover, book.source)
  const checking = useOnline(s => !!s.checking[book.key])
  const showToast = useStore(s => s.showToast)
  const total = chapterCount(book.volumes)
  const read = book.progress ? flatIndex(book.volumes, book.progress) + 1 : 0

  const check = async () => {
    const r = await checkOnlineUpdate(book.key)
    if (r.error) showToast(tr('检查更新失败：{e}', { e: r.error }))
    else showToast(r.added ? tr('《{title}》更新了 {n} 章', { title: book.title, n: r.added }) : tr('《{title}》没有新章节', { title: book.title }))
  }

  const remove = async () => {
    const ok = await askConfirm({
      title: tr('移出在线书架'),
      message: tr('把《{title}》移出在线书架？阅读进度会暂时保留。', { title: book.title }),
      okText: tr('移出'),
      danger: true,
    })
    if (ok) {
      await removeFromOnlineShelf(book.key)
      showToast(tr('已移出在线书架'))
    }
  }

  return (
    <div className="ol-card glass">
      <button className="ol-cover" onClick={onDetails} aria-label={book.title}>
        {cover.src ? <img src={cover.src} alt="" draggable={false} /> : <span className="serif">{book.title.slice(0, 1)}</span>}
        {book.newChapters > 0 && <i className="ol-badge">{book.newChapters > 99 ? '99+' : book.newChapters}</i>}
      </button>
      <div className="ol-text">
        <button className="ol-title serif" onClick={onDetails}>
          {book.title}
        </button>
        <span className="muted">{[book.author, sourceName(book.source)].filter(Boolean).join(' · ')}</span>
        <span className="ol-progress">{progressLabel(book)}</span>
        <span className="ol-meta">
          {total ? tr('{read} / {total} 章', { read, total }) : tr('目录未读取')}
          {book.newChapters > 0 && <b>{tr(' · {n} 章新内容', { n: book.newChapters })}</b>}
          {book.checkedAt > 0 && <> · {tr('{t}检查过', { t: ago(book.checkedAt) })}</>}
        </span>
        <div className="ol-actions">
          <button className="btn primary" onClick={onOpen}>
            {book.progress ? tr('继续阅读') : tr('开始阅读')}
            <IconChevronR />
          </button>
          <button className="btn ghost ol-icon" onClick={check} disabled={checking} aria-label={tr('检查更新')} title={tr('检查更新')}>
            <IconSync className={checking ? 'ol-spin' : ''} />
          </button>
          <button className="btn ghost ol-icon danger" onClick={remove} aria-label={tr('移出在线书架')} title={tr('移出在线书架')}>
            <IconTrash />
          </button>
        </div>
      </div>
    </div>
  )
}
