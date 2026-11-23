import { useEffect, useRef, useState } from 'react'
import Sheet from './Sheet'
import { IconCheck, IconDownload, IconSearch, IconX } from './icons'
import { tr } from '../lib/i18n'
import { useStore } from '../lib/store'
import { cancelBrowser, onBrowserHidden, showBrowser } from '../lib/sources/browser'
import { cancelDownload, downloadToShelf, fetchImage, pauseDownload, useDownloads } from '../lib/sources/download'
import { wenku8 } from '../lib/sources/wenku8'
import { linovelib } from '../lib/sources/linovelib'
import type { BookSource, SearchHit, SearchOutcome, SourceBook, SourceVolume } from '../lib/sources/types'
import { pushOverlay } from '../lib/overlay'
import { loadCover, peekCover } from '../lib/covers'
import { checkUpdates, planUpdate, shelfBookOf, sourceBooks, useUpdateCheck } from '../lib/sources/update'
import OnlineShelf from './OnlineShelf'
import { openOnlineInReader } from '../lib/sources/onlinebook'
import { toggleOnlineShelf, useOnShelf } from '../lib/sources/online'
import '../styles-sources.css'

export const SOURCES: BookSource[] = [linovelib, wenku8]
const byId = (id: string) => SOURCES.find(s => s.id === id)!

/* ---------- 封面：图片站有防盗链，交给 Rust 带上来源页下载，再变成 blob 地址 ---------- */
const coverCache = new Map<string, Promise<string>>()
function useCover(url: string, referer: string) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    if (!url) return
    let alive = true
    if (!coverCache.has(url))
      coverCache.set(
        url,
        fetchImage(url, referer).then(img => (img ? URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.type })) : '')),
      )
    coverCache.get(url)!.then(s => alive && setSrc(s))
    return () => {
      alive = false
    }
  }, [url, referer])
  return src
}

/** 书架上的书的封面（用本地已有的封面图） */
function ShelfCover({ hash, title }: { hash: string; title: string }) {
  const [src, setSrc] = useState(() => peekCover(hash) ?? '')
  useEffect(() => {
    let alive = true
    loadCover(hash).then(u => alive && u && setSrc(u))
    return () => {
      alive = false
    }
  }, [hash])
  return <div className="src-cover">{src ? <img src={src} alt="" draggable={false} /> : <span className="serif">{title.slice(0, 1)}</span>}</div>
}

function Cover({ url, source, title }: { url: string; source: string; title: string }) {
  const src = useCover(url, byId(source).referer)
  return <div className="src-cover">{src ? <img src={src} alt="" draggable={false} /> : <span className="serif">{title.slice(0, 1)}</span>}</div>
}

type View =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'hits'; hits: SearchHit[] }
  | { kind: 'captcha'; image: string }
  | { kind: 'login' }
  | { kind: 'error'; message: string }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function SourcesPage() {
  const [sourceId, setSourceId] = useState(SOURCES[0].id)
  const source = byId(sourceId)
  const [q, setQ] = useState('')
  const [view, setView] = useState<View>({ kind: 'idle' })
  const [pane, setPane] = useState<'find' | 'shelf'>(() => {
    try {
      return localStorage.getItem('readly.sourcesPane') === 'shelf' ? 'shelf' : 'find'
    } catch {
      return 'find'
    }
  })
  const pickPane = (p: 'find' | 'shelf') => {
    setPane(p)
    try {
      localStorage.setItem('readly.sourcesPane', p)
    } catch {
      /* 存不了就算了 */
    }
  }
  const [code, setCode] = useState('')
  const [open, setOpen] = useState<{ source: string; id: string } | null>(null)
  const busy = useRef<AbortController | null>(null)
  // 详情面板：压一条历史记录，安卓返回键先关面板而不是退出应用
  const dismissSheet = useRef<(() => void) | null>(null)
  const openSheet = (o: { source: string; id: string }) => {
    setOpen(o)
    dismissSheet.current = pushOverlay(() => {
      dismissSheet.current = null
      setOpen(null)
    })
  }
  const closeSheet = () => (dismissSheet.current ? dismissSheet.current() : setOpen(null))
  const downloads = useDownloads(s => s.list)
  const library = useStore(s => s.library)
  const fromSources = sourceBooks(library)
  const withUpdates = fromSources.filter(b => b.source!.newVolumes || b.source!.newChapters)
  const checking = useUpdateCheck()
  // 第一次打开书库页时，顺手检查一下超过 12 小时没查过的书有没有更新
  useEffect(() => {
    const t = setTimeout(() => checkUpdates(true), 1500)
    return () => clearTimeout(t)
  }, [])

  const show = (r: SearchOutcome) => {
    if ('captcha' in r) {
      setCode('')
      setView({ kind: 'captcha', image: r.captcha })
    } else if ('needLogin' in r) setView({ kind: 'login' })
    else setView({ kind: 'hits', hits: r.hits })
  }

  const run = async (fn: (signal: AbortSignal) => Promise<SearchOutcome>) => {
    busy.current?.abort()
    const ctrl = new AbortController()
    busy.current = ctrl
    setView({ kind: 'loading' })
    // 网站一直没反应时不要无限等
    const timer = setTimeout(() => ctrl.abort(), 60_000)
    try {
      const r = await fn(ctrl.signal)
      if (busy.current === ctrl) show(r)
    } catch (e) {
      if (busy.current !== ctrl) return
      setView(ctrl.signal.aborted ? { kind: 'error', message: tr('网站太久没有响应，请重试') } : { kind: 'error', message: errText(e) })
    } finally {
      clearTimeout(timer)
      if (busy.current === ctrl) busy.current = null
    }
  }

  const cancelSearch = () => {
    busy.current?.abort()
    busy.current = null
    cancelBrowser()
    setView({ kind: 'idle' })
  }

  const search = () => {
    const kw = q.trim()
    if (!kw) return
    // 粘贴的是书页链接或书号：直接打开
    for (const s of /^https?:/.test(kw) ? SOURCES : [source]) {
      const id = s.parseId(kw)
      if (id && (/^https?:/.test(kw) || /^\d+$/.test(kw))) {
        openSheet({ source: s.id, id })
        return
      }
    }
    run(signal => source.search(kw, signal))
  }

  // 登录窗口收起后自动重新搜索
  useEffect(() => {
    if (view.kind !== 'login') return
    return onBrowserHidden(() => search())
  })

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 820 }}>
        <header className="page-head">
          <div>
            <h1>{tr('书库')}</h1>
            <div className="sub">{tr('从哔哩轻小说、轻小说文库找书，在线阅读或下载后加入书架')}</div>
          </div>
          <div className="seg src-pane-seg">
            <button className={pane === 'find' ? 'on' : ''} onClick={() => pickPane('find')}>
              {tr('找书')}
            </button>
            <button className={pane === 'shelf' ? 'on' : ''} onClick={() => pickPane('shelf')}>
              {tr('在线书架')}
            </button>
          </div>
        </header>

        {pane === 'shelf' ? (
          <OnlineShelf onDetails={b => openSheet({ source: b.source, id: b.id })} />
        ) : (
          <>
            <div className="src-bar glass">
              <div className="seg">
                {SOURCES.map(s => (
                  <button key={s.id} className={s.id === sourceId ? 'on' : ''} onClick={() => setSourceId(s.id)}>
                    {tr(s.name)}
                  </button>
                ))}
              </div>
              <form
                className="src-search"
                onSubmit={e => {
                  e.preventDefault()
                  search()
                }}
              >
                <IconSearch className="src-search-icon" />
                <input className="field" value={q} onChange={e => setQ(e.target.value)} placeholder={tr('书名、作者，或粘贴书页链接')} enterKeyHint="search" />
                {view.kind === 'loading' ? (
                  <button className="btn" type="button" onClick={cancelSearch}>
                    {tr('取消')}
                  </button>
                ) : (
                  <button className="btn primary" type="submit" disabled={!q.trim()}>
                    {tr('搜索')}
                  </button>
                )}
              </form>
            </div>

            {!!downloads.length && (
              <div className="src-card glass src-downloads">
                <b>{tr('正在下载')}</b>
                {downloads.map(d => (
                  <div key={d.key} className="src-dl">
                    <div className="src-dl-text">
                      <span className="serif">{d.title}</span>
                      <span className="muted">
                        {d.paused ? tr('已暂停 · ') : ''}
                        {d.stage === 'chapters'
                          ? tr('{done} / {total} 章', {
                              done: d.done,
                              total: d.total,
                            }) + (d.failed ? tr('，{n} 章失败', { n: d.failed }) : '')
                          : d.stage === 'images'
                            ? tr('下载插图…')
                            : tr('正在加入书架…')}
                      </span>
                      <i className="src-dl-bar">
                        <i
                          style={{
                            width: `${d.total ? (d.done / d.total) * 100 : 0}%`,
                          }}
                        />
                      </i>
                    </div>
                    <button className="btn ghost" onClick={() => pauseDownload(d.key, !d.paused)}>
                      {d.paused ? tr('继续') : tr('暂停')}
                    </button>
                    <button className="btn ghost" onClick={() => cancelDownload(d.key)} aria-label={tr('取消下载')}>
                      <IconX />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!!fromSources.length && (
              <div className="src-card glass src-updates">
                <div className="src-updates-head">
                  <b>
                    {withUpdates.length
                      ? tr('书架上有 {n} 本书更新了', { n: withUpdates.length })
                      : tr('书架上从书库下载的书：{n} 本', {
                          n: fromSources.length,
                        })}
                  </b>
                  <button className="btn ghost" disabled={checking.running} onClick={() => checkUpdates(false)}>
                    {checking.running
                      ? tr('检查中 {done} / {total}', {
                          done: checking.done,
                          total: checking.total,
                        })
                      : tr('检查更新')}
                  </button>
                </div>
                {withUpdates.map(b => (
                  <button key={b.hash} className="src-upd" onClick={() => openSheet({ source: b.source!.kind, id: b.source!.id })}>
                    <ShelfCover hash={b.hash} title={b.title} />
                    <div className="src-upd-text">
                      <span className="serif">{b.title}</span>
                      <span className="new">
                        {[
                          b.source!.newVolumes && tr('新出 {n} 卷', { n: b.source!.newVolumes }),
                          b.source!.newChapters &&
                            tr('最后一卷新增 {n} 章', {
                              n: b.source!.newChapters,
                            }),
                        ]
                          .filter(Boolean)
                          .join('，')}
                      </span>
                      <span className="muted">{tr('点开后可以追加到书架，进度和书签都保留')}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {view.kind === 'loading' && <div className="src-state">{tr('正在打开网站…')}</div>}
            {view.kind === 'error' && <div className="src-state error">{tr('出错了：{e}', { e: view.message })}</div>}
            {view.kind === 'idle' && (
              <div className="src-state">{tr('输入书名搜索。哔哩轻小说第一次搜索要输入验证码，之后 30 分钟内不用再输；轻小说文库搜索需要先登录。')}</div>
            )}

            {view.kind === 'captcha' && (
              <form
                className="src-card glass"
                onSubmit={e => {
                  e.preventDefault()
                  if (code.trim().length === 4 && source.submitCaptcha) run(signal => source.submitCaptcha!(code, signal))
                }}
              >
                <b>{tr('请输入图片里的验证码')}</b>
                <div className="src-captcha">
                  <img src={view.image} alt={tr('验证码')} onClick={() => search()} title={tr('点击换一张')} />
                  <input
                    className="field mono"
                    value={code}
                    maxLength={4}
                    autoFocus
                    autoCapitalize="off"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={e => setCode(e.target.value.replace(/[^A-Za-z0-9]/g, ''))}
                  />
                  <button className="btn primary" type="submit" disabled={code.length !== 4}>
                    {tr('确定')}
                  </button>
                </div>
                <div className="hint">{tr('看不清可以点图片换一张。通过后 30 分钟内搜索不用再输。')}</div>
              </form>
            )}

            {view.kind === 'login' && (
              <div className="src-card glass">
                <b>{tr('{name}的搜索需要登录', { name: tr(source.name) })}</b>
                <div className="hint">
                  {tr('会打开网站自己的登录页，账号密码只在网页里输入，Readly 不会保存。登录后关掉窗口（手机上点顶部的「关闭」），会自动重新搜索。')}
                </div>
                <div className="btn-row" style={{ marginTop: 12 }}>
                  <button className="btn primary" onClick={() => showBrowser(source.loginUrl, true)}>
                    {tr('打开登录页')}
                  </button>
                  <button className="btn" onClick={() => search()}>
                    {tr('已登录，重新搜索')}
                  </button>
                </div>
              </div>
            )}

            {view.kind === 'hits' &&
              (view.hits.length ? (
                <div className="src-hits">
                  {view.hits.map(h => (
                    <button key={h.source + h.id} className="src-hit glass" onClick={() => openSheet({ source: h.source, id: h.id })}>
                      <Cover url={h.cover} source={h.source} title={h.title} />
                      <div className="src-hit-text">
                        <b className="serif">{h.title}</b>
                        {h.author && <span className="muted">{h.author}</span>}
                        {h.intro && <p>{h.intro}</p>}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="src-state">{tr('没有找到。可以换个关键词，或换一个书源试试。')}</div>
              ))}
          </>
        )}
      </div>
      {open && <BookSheet source={byId(open.source)} id={open.id} onClose={closeSheet} />}
    </div>
  )
}

/** 书籍详情：简介、分卷目录（勾选要下载的卷）、加入书架 */
function BookSheet({ source, id, onClose }: { source: BookSource; id: string; onClose: () => void }) {
  const [book, setBook] = useState<SourceBook | null>(null)
  const [vols, setVols] = useState<SourceVolume[] | null>(null)
  const [pick, setPick] = useState<Set<number>>(new Set())
  const [error, setError] = useState('')
  const key = `${source.id}:${id}`
  const dl = useDownloads(s => s.list.find(d => d.key === key))
  const [fullDesc, setFullDesc] = useState(false)
  const showToast = useStore(s => s.showToast)
  // 书架上已经有这本书（以前从书库下载过）：只能追加新内容
  const shelf = useStore(s => shelfBookOf(s.library, source.id, id))
  const onlineShelved = useOnShelf(source.id, id)
  const plan = shelf?.source && vols ? planUpdate(shelf.source, vols) : null

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const b = await source.getBook(id)
        if (!alive) return
        setBook(b)
        const v = await source.getVolumes(id)
        if (!alive) return
        setVols(v)
        // 书架上已有这本书：默认只勾可以追加的新卷
        const have = shelfBookOf(useStore.getState().library, source.id, id)
        const p = have?.source ? planUpdate(have.source, v) : null
        setPick(new Set(v.map((_, i) => i).filter(i => !p || p.status[i] === 'new')))
        // 顺手记下检查结果（书库页的“有更新”标记跟着刷新）
        if (have?.source && p)
          useStore.getState().setBookSource(have.hash, {
            ...have.source,
            checkedAt: Date.now(),
            newVolumes: p.newVolumes.length,
            newChapters: p.toLast.length,
          })
      } catch (e) {
        if (alive) setError(errText(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [source, id])

  const selectable = (i: number) => !plan || plan.status[i] === 'new'
  const chosen = vols?.filter((_, i) => pick.has(i) && selectable(i)) ?? []
  const toLast = plan?.toLast ?? []
  const chapters = chosen.reduce((n, v) => n + v.chapters.length, 0) + toLast.length
  const toggle = (i: number) => selectable(i) && setPick(p => (p.has(i) ? new Set([...p].filter(x => x !== i)) : new Set(p).add(i)))
  const allIdx = vols?.map((_, i) => i).filter(selectable) ?? []

  const start = () => {
    if (!book || !chapters) return
    showToast(tr('开始下载，进度显示在书库页面上方'))
    downloadToShelf(source, book, chosen, shelf ? { hash: shelf.hash, toLast } : undefined).catch(
      e => e?.name !== 'AbortError' && showToast(tr('下载失败：{e}', { e: errText(e) })),
    )
  }

  return (
    <>
      <div className="scrim dim book-sheet-scrim" onClick={onClose} />
      <Sheet className="book-sheet src-sheet" onClose={onClose} role="dialog" aria-label={book?.title ?? tr('书籍详情')}>
        {error ? (
          <div className="src-state error">{tr('出错了：{e}', { e: error })}</div>
        ) : !book ? (
          <div className="src-state">{tr('正在读取书籍信息…')}</div>
        ) : (
          <>
            <div className="src-detail">
              <Cover url={book.cover} source={source.id} title={book.title} />
              <div className="src-detail-text">
                <h3 className="serif">{book.title}</h3>
                <span className="muted">{[book.author, book.status, book.updated && tr('更新于 {d}', { d: book.updated })].filter(Boolean).join(' · ')}</span>
                {!!book.tags.length && (
                  <div className="chips" style={{ marginTop: 8 }}>
                    {book.tags.slice(0, 8).map(t => (
                      <span key={t} className="chip">
                        <span>{t}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {book.description && (
              <p className={`src-desc ${fullDesc ? 'full' : ''}`} onClick={() => setFullDesc(v => !v)}>
                {book.description}
                {!fullDesc && <span className="src-more">{tr('展开')}</span>}
              </p>
            )}

            <div className="src-vol-head">
              <b>{vols ? tr('{n} 卷', { n: vols.length }) : tr('正在读取目录…')}</b>
              {vols && !!allIdx.length && (
                <button className="btn ghost" onClick={() => setPick(allIdx.every(i => pick.has(i)) ? new Set() : new Set(allIdx))}>
                  {allIdx.every(i => pick.has(i)) ? tr('全不选') : tr('全选')}
                </button>
              )}
            </div>
            {shelf && (
              <div className="src-merge-note">
                {tr('书架上已有这本书（《{title}》）。新的内容会追加到它的末尾，阅读进度、书签和笔记都保留。', { title: shelf.title })}
                {!!toLast.length && (
                  <b>
                    {tr('最后一卷新出了 {n} 章，会一起追加。', {
                      n: toLast.length,
                    })}
                  </b>
                )}
              </div>
            )}
            <div className="src-vols">
              {vols?.map((v, i) => {
                const st = plan?.status[i]
                const on = st === 'have' || (selectable(i) && pick.has(i))
                return (
                  <button
                    key={v.id + i}
                    className={`cat-row ${on ? 'on' : 'off'} ${st && st !== 'new' ? 'locked' : ''}`}
                    role="checkbox"
                    aria-checked={on}
                    aria-disabled={!selectable(i)}
                    onClick={() => toggle(i)}
                  >
                    <span className="cat-check">{on && <IconCheck />}</span>
                    <span className="cat-name">{v.title}</span>
                    <span className="muted">
                      {st === 'have' ? tr('已在书架') : st === 'gap' ? tr('没下载，无法补到中间') : tr('{n} 章', { n: v.chapters.length })}
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="btn-row src-actions">
              <button className="btn" onClick={() => openOnlineInReader(book, vols ?? undefined)}>
                {tr('在线阅读')}
              </button>
              <button className="btn" onClick={() => toggleOnlineShelf(book, vols ?? undefined)}>
                {onlineShelved ? tr('移出在线书架') : tr('加入在线书架')}
              </button>
              <span style={{ flex: 1 }} />
              {dl ? (
                <button className="btn" onClick={() => cancelDownload(key)}>
                  <IconX />
                  {tr('取消下载（{done} / {total} 章）', {
                    done: dl.done,
                    total: dl.total,
                  })}
                </button>
              ) : (
                <button className="btn primary" disabled={!chapters} onClick={start}>
                  <IconDownload />
                  {shelf
                    ? chapters
                      ? tr('追加到书架（{v} 卷 {c} 章）', {
                          v: chosen.length,
                          c: chapters,
                        })
                      : tr('已是最新')
                    : chapters
                      ? tr('加入书架（{v} 卷 {c} 章）', {
                          v: chosen.length,
                          c: chapters,
                        })
                      : tr('加入书架')}
                </button>
              )}
            </div>
            {dl && (
              <div className="hint" style={{ textAlign: 'right' }}>
                {tr('下载中，可以关掉这里继续做别的事；进度显示在书库页面上方。')}
              </div>
            )}
          </>
        )}
      </Sheet>
    </>
  )
}
