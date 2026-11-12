import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { liveCategories, useShelf, useStore, visibleBooks } from '../lib/store'
import { enterReader, formatTime, useDesktopLayout } from '../lib/hooks'
import { askConfirm } from '../lib/dialog'
import { foldersSupported } from '../lib/folders'
import { fuzzyFilter } from '../lib/fuzzy'
import { pushOverlay } from '../lib/overlay'
import { SHELF_SORTS, type ShelfSort } from '../lib/settings'
import type { BookRecord } from '../lib/types'
import { BookCover } from './BookCover'
import ShelfCarousel from './ShelfCarousel'
import { IconCheck, IconChevronR, IconCloud, IconDownload, IconEdit, IconFolder, IconPlus, IconSearch, IconSort, IconSync, IconTag, IconTrash, IconX } from './icons'
import BookInfoDialog from './BookInfoDialog'
import { AssignSheet, ManageSheet } from './CategorySheets'
import Presence from './Presence'
import Sheet from './Sheet'
import { haptic, isWindowsApp, revealBook } from '../lib/native'
import { cancelLongPress, consumeLongPress, longPress } from '../lib/longpress'
import { tr } from '../lib/i18n'

const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
/** contextmenu 是否由手指长按触发（Chrome/WebView 里它是 PointerEvent） */
const isTouchEvent = (e: React.MouseEvent) => (e.nativeEvent as PointerEvent).pointerType === 'touch'

type Cols = number

/** 当前看的是哪个分类：all 全部 / none 未分类 / 分类 id。切换语言重新挂载后仍然记得 */
let shelfCat = 'all'

interface MenuState {
  rec: BookRecord
  /** 手机：底部面板；电脑：弹出菜单 */
  sheet: boolean
  x: number
  y: number
}

/** 视图档位图标：n 根竖条表示每排 n 本 */
function ColsIcon({ n }: { n: Cols }) {
  if (n === 1)
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
        <rect x="7" y="3" width="10" height="18" rx="2" />
      </svg>
    )
  const gap = n > 4 ? 1.2 : 2
  const w = (20 - gap * (n - 1)) / n
  const h = n > 4 ? 12 : 14 + (4 - n) * 1
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <rect key={i} x={2 + i * (w + gap)} y={(24 - h) / 2} width={w} height={h} rx={Math.min(1.4, w / 3)} />
      ))}
    </svg>
  )
}

/** 手机与电脑各自的档位 */
const LEVELS_MOBILE = [1, 2, 3, 4]
const LEVELS_DESKTOP = [1, 4, 6, 8]
const nearest = (levels: number[], v: number) => levels.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a))

export default function Library() {
  // 阅读时这些数据冻结（见 useShelf）：翻页保存进度不会让整个书架跟着重新计算
  const library = useShelf(s => s.library)
  const syncStatus = useShelf(s => s.syncStatus)
  const lastSyncAt = useShelf(s => s.lastSyncAt)
  const syncEnabled = useStore(s => s.sync.enabled)
  const sort = useStore(s => s.settings.shelfSort ?? 'recent')
  const info = useStore(s => s.settings.shelfInfo ?? 'full')
  const catsOn = useStore(s => !!s.settings.shelfCategories)
  const allCats = useStore(s => s.categories)
  const cats = useMemo(() => liveCategories(allCats), [allCats])
  const desktop = useDesktopLayout()
  const levels = desktop ? LEVELS_DESKTOP : LEVELS_MOBILE
  const cols = nearest(levels, useStore(s => s.settings.shelfColumns))
  const single = cols === 1
  const books = useMemo(() => visibleBooks(library, sort), [library, sort])
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [importMenu, setImportMenu] = useState<{ x: number; y: number } | null>(null)
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editRec, setEditRec] = useState<BookRecord | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)

  /* ---------- 分类 ---------- */
  const [cat, setCatState] = useState(shelfCat)
  const setCat = (c: string) => setCatState((shelfCat = c))
  const liveIds = useMemo(() => new Set(cats.map(c => c.id)), [cats])
  // 分类功能关掉、或当前分类被删了：回到“全部”
  const activeCat = catsOn && (cat === 'all' || cat === 'none' || liveIds.has(cat)) ? cat : 'all'
  const catCount = useMemo(() => {
    const m = new Map<string, number>()
    let none = 0
    for (const b of books) {
      const ids = (b.categories ?? []).filter(id => liveIds.has(id))
      if (!ids.length) none++
      for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1)
    }
    return { by: m, none }
  }, [books, liveIds])
  const inCat = useMemo(
    () =>
      activeCat === 'all'
        ? books
        : activeCat === 'none'
          ? books.filter(b => !b.categories?.some(id => liveIds.has(id)))
          : books.filter(b => b.categories?.includes(activeCat)),
    [books, activeCat, liveIds],
  )
  /** 给哪些书选分类（null 表示面板关着） */
  const [assign, setAssign] = useState<string[] | null>(null)
  const [managing, setManaging] = useState(false)
  const dismissAssign = useRef<() => void>()
  const dismissManage = useRef<() => void>()
  const openAssign = (hashes: string[]) => {
    if (!hashes.length) return
    setAssign(hashes)
    dismissAssign.current = pushOverlay(() => setAssign(null))
  }
  const openManage = () => {
    setManaging(true)
    dismissManage.current = pushOverlay(() => setManaging(false))
  }

  const setCols = useCallback((n: number) => {
    if (n !== useStore.getState().settings.shelfColumns) useStore.getState().updateSettings(s => ({ ...s, shelfColumns: n }))
  }, [])
  /** 在档位间移动 step 格 */
  const levelsRef = useRef(levels)
  levelsRef.current = levels
  const stepCols = useCallback(
    (from: number, step: number) => {
      const lv = levelsRef.current
      const i = lv.indexOf(nearest(lv, from))
      setCols(lv[Math.min(lv.length - 1, Math.max(0, i + step))])
    },
    [setCols],
  )

  // Ctrl + 滚轮 / 双指捏合：在档位之间切换
  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    let acc = 0
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      acc += e.deltaY
      if (Math.abs(acc) < 60) return
      stepCols(useStore.getState().settings.shelfColumns, acc > 0 ? 1 : -1)
      acc = 0
    }
    let startDist = 0
    let startCols = 3
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return
      startDist = dist(e.touches)
      startCols = useStore.getState().settings.shelfColumns
      cancelLongPress()
    }
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !startDist) return
      e.preventDefault()
      // 张开手指 → 每排更少（封面更大）
      const ratio = dist(e.touches) / startDist
      stepCols(startCols, -Math.round(Math.log2(ratio) * 2))
    }
    const onEnd = () => (startDist = 0)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
    }
  }, [stepCols])

  // 入场动画只在书架刚出现、或刚换了每排本数的那一小会儿播放。
  // 之后书的顺序变了（刚读完的书排到最前、同步、搜索）不再给“新进前几名”的书补播，否则看起来就是闪一下
  const riseRef = useRef({ cols: -1, until: 0 })
  if (riseRef.current.cols !== cols) riseRef.current = { cols, until: performance.now() + 900 }
  const rising = performance.now() < riseRef.current.until

  // 模糊搜索：忽略空格标点、可以跳字、支持拼音首字母，按匹配程度排序（见 lib/fuzzy.ts）
  const shown = useMemo(() => fuzzyFilter(inCat, query, b => b), [inCat, query])

  /* ---------- 多选 ---------- */
  const startSelect = (rec?: BookRecord) => {
    // 压入一条历史记录：安卓返回键先退出多选，而不是退出应用
    if (!selecting) history.pushState({ select: 1 }, '')
    setSelecting(true)
    setSelected(new Set(rec ? [rec.hash] : []))
    if (rec) haptic(12)
  }
  const resetSelect = () => {
    setSelecting(false)
    setSelected(new Set())
  }
  const exitSelect = () => {
    if (history.state?.select) history.back() // popstate 里会 reset
    else resetSelect()
  }
  useEffect(() => {
    if (!selecting) return
    // 回退后仍停在多选这条记录上（只是关掉了叠在上面的分类面板）：不退出多选
    const onPop = () => {
      if (!history.state?.select) resetSelect()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [selecting])
  const toggle = (rec: BookRecord) =>
    setSelected(s => {
      const n = new Set(s)
      if (n.has(rec.hash)) n.delete(rec.hash)
      else n.add(rec.hash)
      return n
    })
  const allSelected = shown.length > 0 && shown.every(b => selected.has(b.hash))
  const chosen = books.filter(b => selected.has(b.hash))

  // 安卓返回键 / Esc 退出多选
  useEffect(() => {
    if (!selecting) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.sheet, .dialog') && exitSelect()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting])

  const removeChosen = async (recs: BookRecord[]) => {
    if (!recs.length) return
    const synced = syncEnabled && recs.some(r => !r.localOnly)
    const ok = await askConfirm({
      title: recs.length === 1 ? tr('移除《{title}》？', { title: recs[0].title }) : tr('移除选中的 {n} 本书？', { n: recs.length }),
      message: synced ? tr('其他设备也会同步移除（你手动放进云端或书籍文件夹的原文件不会被删除）。') : tr('本机的书籍文件会被删除。'),
      okText: tr('移除'),
      danger: true,
    })
    if (!ok) return
    await useStore.getState().removeBooks(recs.map(r => r.hash))
    useStore.getState().showToast(tr('已移除 {n} 本书', { n: recs.length }))
    exitSelect()
  }

  const setLocal = async (recs: BookRecord[], localOnly: boolean) => {
    for (const r of recs) if (r.hasFile && !!r.localOnly !== localOnly) await useStore.getState().setLocalOnly(r.hash, localOnly)
    useStore.getState().showToast(localOnly ? tr('已设为仅本机') : tr('已上传到云端'))
    exitSelect()
  }

  /** 书的操作菜单：手机上是底部面板，电脑上是右键弹出菜单；两种入口用同一份操作列表 */
  // 底部面板压入一条历史记录：安卓返回键先关面板；点了某个操作则先关面板（回退这条记录），再执行操作
  const afterClose = useRef<(() => void) | null>(null)
  useEffect(() => {
    const onPop = () => {
      if (history.state?.menu) return
      setMenu(m => (m?.sheet ? null : m))
      const fn = afterClose.current
      afterClose.current = null
      fn?.()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const run = (fn?: () => void) => {
    if (history.state?.menu) {
      afterClose.current = fn ?? null
      history.back()
    } else {
      setMenu(null)
      fn?.()
    }
  }
  const openMenu = (rec: BookRecord, x?: number, y?: number) => {
    haptic(10)
    const sheet = x == null || coarse
    if (sheet && !history.state?.menu) history.pushState({ menu: 1 }, '')
    setMenu({ rec, sheet, x: sheet ? 0 : Math.min(x!, innerWidth - 232), y: sheet ? 0 : Math.min(y!, innerHeight - 340) })
  }
  const folders = useStore(s => s.folders)
  const bookActions = (rec: BookRecord) => {
    const folderPath = rec.folderRef ? folders.find(f => f.id === rec.folderRef!.folderId)?.path : undefined
    return (
      <>
        <button onClick={() => run(() => open(rec))}>
          {rec.hasFile ? <IconChevronR /> : <IconDownload />}
          {rec.hasFile ? (rec.progress ? tr('继续阅读') : tr('开始阅读')) : tr('下载并打开')}
        </button>
        <button onClick={() => run(() => setEditRec(rec))}>
          <IconEdit />
          {tr('编辑信息')}
        </button>
        {catsOn && (
          <button onClick={() => run(() => openAssign([rec.hash]))}>
            <IconTag />
            {tr('分类…')}
          </button>
        )}
        {isWindowsApp && rec.hasFile && (
          <button
            onClick={() => run(() => revealBook(rec, folderPath).catch(e => useStore.getState().showToast(tr('无法打开文件位置：{e}', { e: String(e) }))))}
          >
            <IconFolder />
            {tr('在文件夹中显示')}
          </button>
        )}
        {syncEnabled && rec.hasFile && (
          <button onClick={() => run(() => useStore.getState().setLocalOnly(rec.hash, !rec.localOnly))}>
            <IconCloud />
            {rec.localOnly ? tr('上传到云端') : tr('改为仅本机')}
          </button>
        )}
        <button onClick={() => run(() => startSelect(rec))}>
          <IconCheck />
          {tr('多选')}
        </button>
        <button className="danger" onClick={() => run(() => removeChosen([rec]))}>
          <IconTrash />
          {tr('移除')}
        </button>
      </>
    )
  }

  const open = (rec: BookRecord) => enterReader(rec.hash)

  const closeSearch = () => {
    setQuery('')
    setSearching(false)
  }

  // 电脑快捷键：Ctrl+F 搜索、Ctrl+O 导入、Esc 关闭菜单（书架页被隐藏或在阅读时不响应）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pageRef.current || pageRef.current.closest('.tab-pane.inactive') || useStore.getState().reading) return
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && k === 'f') {
        e.preventDefault()
        setSearching(true)
        // 单本模式下搜索框是点开才出现的：等它渲染出来再聚焦
        setTimeout(() => {
          searchRef.current?.focus()
          searchRef.current?.select()
        }, 0)
      } else if (mod && k === 'o') {
        e.preventDefault()
        inputRef.current?.click()
      } else if (e.key === 'Escape') {
        if (menu) run()
        else if (importMenu) setImportMenu(null)
        else if (sortMenu) setSortMenu(null)
        else if (document.activeElement === searchRef.current) {
          closeSearch()
          searchRef.current?.blur()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const searchField = (autoFocus: boolean) => (
    <div className="shelf-search-wrap">
      <IconSearch />
      <input
        ref={searchRef}
        className="field shelf-search"
        placeholder={tr('搜索书名、作者或拼音首字母')}
        value={query}
        autoFocus={autoFocus}
        enterKeyHint="search"
        onChange={e => setQuery(e.target.value)}
      />
      {(query || single) && (
        <button className="icon-btn" aria-label={tr('清除')} onClick={() => (single ? closeSearch() : (setQuery(''), searchRef.current?.focus()))}>
          <IconX />
        </button>
      )}
    </div>
  )
  const sortButton = (
    <button
      className="icon-btn"
      aria-label={tr('排序方式')}
      title={tr('排序方式')}
      onClick={e => {
        const r = e.currentTarget.getBoundingClientRect()
        setSortMenu({ x: Math.max(8, Math.min(r.left, innerWidth - 200)), y: r.bottom + 6 })
      }}
    >
      <IconSort />
    </button>
  )
  const viewSeg = (
    <div className="seg view-seg" role="radiogroup" aria-label={tr('每排几本')}>
      {levels.map(n => (
        <button key={n} role="radio" aria-checked={cols === n} className={cols === n ? 'on' : ''} title={n === 1 ? tr('单本') : tr('每排 {n} 本', { n })} onClick={() => setCols(n)}>
          <ColsIcon n={n} />
        </button>
      ))}
    </div>
  )

  return (
    <div className={`page shelf-page ${single ? 'shelf-single' : ''}`} ref={pageRef}>
      <div className={`page-inner shelf-w${cols}`}>
        <header className="page-head shelf-head">
          {selecting ? (
            <div>
              <h1>{tr('已选 {n} 本', { n: selected.size })}</h1>
              <div className="sub">{tr('点击封面选择，长按也能进入多选')}</div>
            </div>
          ) : single && searching ? (
            searchField(true)
          ) : (
            <div>
              <h1>{tr('书架')}</h1>
              <div className="sub">{tr('{n} 本书', { n: books.length })}</div>
              {syncEnabled && <div className="sub sub2">{tr('同步于 {time}', { time: formatTime(lastSyncAt) })}</div>}
            </div>
          )}
          <div className="shelf-head-side">
            <div className="btn-row">
              {selecting ? (
                <>
                  <button className="btn" onClick={() => setSelected(allSelected ? new Set() : new Set(shown.map(b => b.hash)))}>
                    {allSelected ? tr('取消全选') : tr('全选')}
                  </button>
                  <button className="btn primary" onClick={exitSelect}>
                    {tr('完成')}
                  </button>
                </>
              ) : (
                <>
                  {books.length > 0 && (
                    <button className="btn" onClick={() => startSelect()}>
                      <IconCheck />
                      {tr('编辑')}
                    </button>
                  )}
                  {syncEnabled && (
                    <button className="icon-btn" aria-label={tr('同步')} title={tr('同步')} onClick={() => useStore.getState().runSync()} disabled={syncStatus === 'syncing'}>
                      <IconSync style={syncStatus === 'syncing' ? { animation: 'pulse .6s infinite alternate' } : undefined} />
                    </button>
                  )}
                  <button
                    className="btn primary"
                    onClick={e => {
                      if (!foldersSupported) return inputRef.current?.click()
                      const r = e.currentTarget.getBoundingClientRect()
                      setImportMenu({ x: Math.min(r.left, innerWidth - 220), y: r.bottom + 6 })
                    }}
                  >
                    <IconPlus />
                    {tr('导入')}
                  </button>
                </>
              )}
            </div>
            {/* 单本模式：排序、搜索、视图切换收进标题栏右侧，把竖向空间让给封面 */}
            {single && books.length > 0 && (
              <div className="shelf-mini-tools">
                {sortButton}
                {books.length > 8 && !searching && (
                  <button className="icon-btn" aria-label={tr('搜索')} title={tr('搜索')} onClick={() => setSearching(true)}>
                    <IconSearch />
                  </button>
                )}
                {viewSeg}
              </div>
            )}
          </div>
        </header>

        {catsOn && books.length > 0 && (
          <div className="cat-bar" role="tablist" aria-label={tr('分类')}>
            <button role="tab" aria-selected={activeCat === 'all'} className={`cat-chip ${activeCat === 'all' ? 'on' : ''}`} onClick={() => setCat('all')}>
              {tr('全部')}
              <i>{books.length}</i>
            </button>
            {cats.map(c => (
              <button key={c.id} role="tab" aria-selected={activeCat === c.id} className={`cat-chip ${activeCat === c.id ? 'on' : ''}`} onClick={() => setCat(c.id)}>
                {c.name}
                <i>{catCount.by.get(c.id) ?? 0}</i>
              </button>
            ))}
            {cats.length > 0 && catCount.none > 0 && (
              <button role="tab" aria-selected={activeCat === 'none'} className={`cat-chip ${activeCat === 'none' ? 'on' : ''}`} onClick={() => setCat('none')}>
                {tr('未分类')}
                <i>{catCount.none}</i>
              </button>
            )}
            <button className="cat-chip ghost" onClick={openManage}>
              {cats.length ? <IconEdit /> : <IconPlus />}
              {cats.length ? tr('管理') : tr('新建分类')}
            </button>
          </div>
        )}

        {books.length > 0 && !single && (
          <div className="shelf-tools">
            {books.length > 8 ? searchField(false) : <span />}
            <div className="shelf-tools-side">
              {sortButton}
              {viewSeg}
            </div>
          </div>
        )}

        <Presence show={!!importMenu}>
          {importMenu && (
            <>
              <div className="scrim" onClick={() => setImportMenu(null)} />
              <div className="menu-pop glass" style={{ left: importMenu.x, top: importMenu.y }}>
                <button onClick={() => (setImportMenu(null), inputRef.current?.click())}>
                  <IconPlus />
                  {tr('导入书籍文件')}
                </button>
                <button onClick={() => (setImportMenu(null), useStore.getState().addFolder())}>
                  <IconFolder />
                  {tr('同步一个文件夹')}
                </button>
              </div>
            </>
          )}
        </Presence>

        <Presence show={!!sortMenu}>
          {sortMenu && (
            <>
              <div className="scrim" onClick={() => setSortMenu(null)} />
              <div className="menu-pop glass" style={{ left: sortMenu.x, top: sortMenu.y }}>
                {SHELF_SORTS.map(([id, name]) => (
                  <button
                    key={id}
                    className={sort === id ? 'on' : ''}
                    onClick={() => {
                      setSortMenu(null)
                      useStore.getState().updateSettings(s => ({ ...s, shelfSort: id as ShelfSort }))
                    }}
                  >
                    {sort === id ? <IconCheck /> : <span className="menu-gap" />}
                    {tr(name)}
                  </button>
                ))}
              </div>
            </>
          )}
        </Presence>

        {books.length === 0 ? (
          <div className="empty glass">
            <h2>{tr('书架还是空的')}</h2>
            <p>{tr('导入 EPUB 或 TXT，或者把文件拖进窗口。')}{syncEnabled && tr('放进云端 Readly 目录的书也会自动出现在这里。')}</p>
            <div className="btn-row" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => inputRef.current?.click()}>
                <IconPlus />
                {tr('导入书籍')}
              </button>
              {foldersSupported && (
                <button className="btn" onClick={() => useStore.getState().addFolder()}>
                  <IconFolder />
                  {tr('同步一个文件夹')}
                </button>
              )}
            </div>
          </div>
        ) : shown.length === 0 ? (
          <div className="empty glass shelf-none">
            <p>{query.trim() ? tr('没有找到和“{q}”相关的书', { q: query.trim() }) : tr('这个分类里还没有书。长按一本书，选“分类…”就能放进来。')}</p>
            {query.trim() ? (
              <button className="btn" onClick={closeSearch}>
                {tr('清除搜索')}
              </button>
            ) : (
              <button className="btn" onClick={() => setCat('all')}>
                {tr('查看全部')}
              </button>
            )}
          </div>
        ) : single ? (
          <ShelfCarousel
            books={shown}
            selecting={selecting}
            selected={selected}
            onOpen={open}
            onToggle={toggle}
            onLongPress={rec => (selecting ? toggle(rec) : openMenu(rec))}
            onMenu={(rec, x, y) => !selecting && openMenu(rec, x, y)}
          />
        ) : (
          <div key={cols} className={`shelf cols-${cols} info-${info}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {shown.map((rec, i) => {
              const pct = Math.round((rec.progress?.fraction ?? 0) * 100)
              const isSel = selected.has(rec.hash)
              return (
                <button
                  key={rec.hash}
                  data-book={rec.hash}
                  className={`book ${rising && i < 16 ? 'rise' : ''} ${isSel ? 'is-selected' : ''}`}
                  style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}
                  aria-label={rec.title}
                  onClick={() => {
                    if (consumeLongPress()) return
                    if (selecting) toggle(rec)
                    else open(rec)
                  }}
                  onContextMenu={e => {
                    e.preventDefault()
                    // 手机长按也会触发 contextmenu：已由上面的长按计时处理，这里忽略，避免弹出两个菜单
                    if (isTouchEvent(e)) return
                    if (selecting) return toggle(rec)
                    openMenu(rec, e.clientX, e.clientY)
                  }}
                  {...longPress(() => (selecting ? toggle(rec) : openMenu(rec)))}
                >
                  <BookCover rec={rec} large={cols <= 2} selecting={selecting} selected={isSel} />
                  {info !== 'cover' && (
                    <div className="book-meta">
                      <div className="book-title">{rec.title}</div>
                      {info === 'full' && (
                        <>
                          <div className="book-sub">
                            <span>{rec.author || (rec.format === 'txt' ? 'TXT' : tr('佚名'))}</span>
                            <span>{rec.progress ? `${pct}%` : tr('未读')}</span>
                          </div>
                          {/* 没开始读的书也留出进度条的位置：同一排的书名、作者才能对齐 */}
                          <div className={`progress-line ${rec.progress ? '' : 'unread'}`}>
                            <i style={{ width: `${pct}%` }} />
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 多选操作栏：浮在 Dock 上方 */}
      <Presence show={selecting}>
        {selecting && (
          <div className="select-bar glass">
            <button className="btn" disabled={chosen.length !== 1} onClick={() => setEditRec(chosen[0])}>
              <IconEdit />
              {tr('编辑信息')}
            </button>
            {catsOn && (
              <button className="btn" disabled={!chosen.length} onClick={() => openAssign(chosen.map(b => b.hash))}>
                <IconTag />
                {tr('分类')}
              </button>
            )}
            <button className="btn danger" disabled={!chosen.length} onClick={() => removeChosen(chosen)}>
              <IconTrash />
              {tr('移除')}{chosen.length ? ` ${chosen.length}` : ''}
            </button>
            {syncEnabled && (
              <>
                <button className="btn" disabled={!chosen.some(b => b.localOnly && b.hasFile)} onClick={() => setLocal(chosen, false)}>
                  <IconCloud />
                  {tr('上传云端')}
                </button>
                <button className="btn" disabled={!chosen.some(b => !b.localOnly && b.hasFile)} onClick={() => setLocal(chosen, true)}>
                  {tr('仅本机')}
                </button>
              </>
            )}
          </div>
        )}
      </Presence>

      <Presence show={!!editRec}>
        {editRec && (
          <BookInfoDialog
            rec={useStore.getState().library.find(b => b.hash === editRec.hash) ?? editRec}
            onClose={() => setEditRec(null)}
          />
        )}
      </Presence>

      <input
        ref={inputRef}
        type="file"
        accept=".epub,.txt,application/epub+zip,text/plain"
        multiple
        hidden
        onChange={e => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) useStore.getState().importFiles(files)
        }}
      />

      {/* 手机：底部面板（挂到 body 上，页面容器有自己的层叠上下文，放在里面会被底部导航条盖住） */}
      {createPortal(
        <>
          <Presence show={!!menu?.sheet}>
            {menu?.sheet && (
              <>
                <div className="scrim dim book-sheet-scrim" onClick={() => run()} />
                <Sheet className="book-sheet" onClose={() => run()} role="dialog" aria-label={menu.rec.title}>
                  <div className="book-sheet-head">
                    <div className="book-sheet-cover">
                      <BookCover rec={menu.rec} />
                    </div>
                    <div>
                      <b className="serif">{menu.rec.title}</b>
                      <span>
                        {menu.rec.author || (menu.rec.format === 'txt' ? 'TXT' : tr('佚名'))}
                        {menu.rec.progress ? ` · ${tr('已读 {pct}%', { pct: Math.round(menu.rec.progress.fraction * 100) })}` : tr(' · 未读')}
                        {!menu.rec.hasFile ? tr(' · 在云端') : menu.rec.localOnly ? tr(' · 仅本机') : ''}
                      </span>
                    </div>
                  </div>
                  <div className="book-sheet-actions">{bookActions(menu.rec)}</div>
                </Sheet>
              </>
            )}
          </Presence>
          <Presence show={!!assign}>{assign && <AssignSheet hashes={assign} onClose={() => dismissAssign.current?.()} />}</Presence>
          <Presence show={managing}>{managing && <ManageSheet onClose={() => dismissManage.current?.()} />}</Presence>
        </>,
        document.body,
      )}
      {/* 电脑：右键弹出菜单 */}
      <Presence show={!!menu && !menu.sheet}>
        {menu && !menu.sheet && (
          <>
            <div className="scrim" onClick={() => setMenu(null)} onContextMenu={e => (e.preventDefault(), setMenu(null))} />
            <div className="menu-pop glass" style={{ left: menu.x, top: menu.y }}>
              {bookActions(menu.rec)}
            </div>
          </>
        )}
      </Presence>
    </div>
  )
}
