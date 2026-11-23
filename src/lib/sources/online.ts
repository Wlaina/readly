/**
 * 在线阅读与在线书架：不下载，直接从书源一章章读。
 *
 * - 每本读过的在线书记一条 OnlineBook（书源、书号、书名、封面、目录快照、进度…），持久化到 paths.online。
 *   shelved = true 的才出现在“在线书架”上；没收藏的只记进度（最多保留 MAX_LOOSE 本最近读的），再次打开能回到原处。
 * - 章节正文：内存缓存 + 预取下一章。正文走隐藏网页 slot 0（与搜索共用），预取走 slot 1。
 *   同一个槽位一次只开一页，这里自己排队；排队中没人要了的请求直接丢掉，不白白占着网页。
 * - 检查更新：重新取目录，和快照比章节数，记下新章节数并换上新目录（进度按章节 id 重新定位）。
 * - 同步：每本在线书在书架上有一条隐藏记录（BookRecord.online），“在不在在线书架上”记在它上面，
 *   随书架同步到其他设备；其他设备同步下来的记录在这里补成在线书架上的书（目录等打开时再取）。
 */
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { paths, readJSON, writeJSON } from '../storage'
import { useStore } from '../store'
import type { BookRecord } from '../types'
import { tr } from '../i18n'
import { activeDownloads, fetchImage } from './download'
import { wenku8 } from './wenku8'
import { linovelib } from './linovelib'
import type { BookSource, ChapterContent, SourceBook, SourceChapter, SourceVolume } from './types'

/* ---------- 数据结构 ---------- */

/** 阅读进度：第几卷、第几章（从 0 开始），章内滚动位置 */
export interface OnlineProgress {
  vol: number
  ch: number
  /** 章内位置比例 0 ~ 1（滚动距离 / 可滚动高度） */
  ratio: number
  /** 当时屏幕最上面的是第几段（恢复位置时优先用它，插图加载前后都准） */
  block?: number
  /** 章节 id：目录更新后卷/章序号变了，靠它重新定位 */
  chapterId: string
  at: number
}

/** 在线书的书签：记在书籍记录里（随 online.json 存盘，不参与同步） */
export interface OnlineBookmark {
  id: string
  vol: number
  ch: number
  /** 章节 id：目录更新后靠它重新定位 */
  chapterId: string
  /** 章内位置比例 0 ~ 1 */
  ratio: number
  /** 书签所在的段落序号（恢复位置时优先用它） */
  block?: number
  /** 章节标题（列表里显示） */
  chapterTitle: string
  /** 书签处的一小段正文 */
  excerpt: string
  at: number
}

export interface OnlineBook {
  /** `${source}:${id}` */
  key: string
  source: string
  id: string
  title: string
  author: string
  cover: string
  description?: string
  /** 目录快照（各卷标题与章节 id / 标题 / 地址） */
  volumes: SourceVolume[]
  progress: OnlineProgress | null
  /** 是否在在线书架上 */
  shelved: boolean
  /** 加入在线书架的时间（没收藏为 0） */
  addedAt: number
  /** 上次阅读时间 */
  readAt: number
  /** 上次检查更新时间 */
  checkedAt: number
  /** 上次检查更新发现的新章节数（打开阅读后清零） */
  newChapters: number
  /** 书签（按加入时间排列；旧记录没有这一项） */
  bookmarks?: OnlineBookmark[]
}

export interface ChapterPos {
  vol: number
  ch: number
}

interface OnlineFile {
  version: 1
  books: OnlineBook[]
}

interface OnlineState {
  loaded: boolean
  books: Record<string, OnlineBook>
  /** 正在检查更新的书 */
  checking: Record<string, boolean>
  /** “全部检查更新”的进度 */
  checkAll: { done: number; total: number } | null
}

export const useOnline = create<OnlineState>(() => ({
  loaded: false,
  books: {},
  checking: {},
  checkAll: null,
}))

/** 没收藏、只是读过的书最多记这么多本 */
const MAX_LOOSE = 40

/* ---------- 书源 ---------- */

const sourceMap = new Map<string, BookSource>([
  [linovelib.id, linovelib],
  [wenku8.id, wenku8],
])

/** 以后加了新书源，在这里登记一下在线阅读就能用 */
export function registerOnlineSource(s: BookSource) {
  sourceMap.set(s.id, s)
}

export function sourceOf(id: string): BookSource {
  const s = sourceMap.get(id)
  if (!s) throw new Error(tr('未知的书源：{id}', { id }))
  return s
}

export const onlineKey = (source: string, id: string) => `${source}:${id}`
/** 在线书在书架上的隐藏记录的 hash */
export const onlineHash = (source: string, id: string) => `online-${source}-${id}`

/** 在线书的隐藏记录（新建用的模板）：没有书籍文件，随书架同步 */
export function onlineRecordFor(b: Pick<OnlineBook, 'source' | 'id' | 'title' | 'author' | 'cover'>, shelved = false): BookRecord {
  const now = Date.now()
  return {
    hash: onlineHash(b.source, b.id),
    title: b.title,
    author: b.author || '',
    // 用 txt 的排版（纯段落，首行缩进）
    format: 'txt',
    fileName: `${b.title}.online`,
    size: 0,
    addedAt: now,
    metaUpdatedAt: now,
    bookmarks: [],
    hasFile: false,
    hasCover: false,
    coverChecked: true,
    online: { kind: b.source, id: b.id, shelved, cover: b.cover || undefined },
    updatedAt: now,
  }
}

/** 把“在不在在线书架上”写到隐藏记录上（随书架同步） */
function recordShelf(key: string) {
  const b = useOnline.getState().books[key]
  if (b) useStore.getState().setOnlineShelfRecord(onlineRecordFor(b, b.shelved), b.shelved)
}

/* ---------- 持久化 ---------- */

/** 链接坏掉的章节要靠上一章找回地址：prev.ref 是对上一章对象的引用，存盘时去掉，读回来再连上 */
function linkPrev(volumes: SourceVolume[]): SourceVolume[] {
  const byId = new Map<string, SourceChapter>()
  for (const v of volumes) for (const c of v.chapters) byId.set(c.id, c)
  for (const v of volumes)
    for (const c of v.chapters) {
      if (c.prev && !c.prev.ref) {
        const ref = byId.get(c.prev.id)
        if (ref) c.prev.ref = ref
      }
    }
  return volumes
}

/** 目录快照：只留需要的字段，去掉对象引用 */
function snapshot(volumes: SourceVolume[]): SourceVolume[] {
  return linkPrev(
    volumes.map(v => ({
      id: v.id,
      title: v.title,
      chapters: v.chapters.map(c => ({
        id: c.id,
        title: c.title,
        url: c.url,
        ...(c.prev ? { prev: { url: c.prev.url, id: c.prev.id } } : {}),
      })),
    })),
  )
}

let loading: Promise<void> | null = null

/** 读取在线书架（只读一次；其余函数会自动等它） */
export function loadOnline(): Promise<void> {
  return (loading ??= (async () => {
    const file = await readJSON<OnlineFile | null>(paths.online, null)
    const books: Record<string, OnlineBook> = {}
    for (const b of file?.books ?? []) {
      if (!b?.source || !b.id) continue
      books[b.key || onlineKey(b.source, b.id)] = {
        ...b,
        key: b.key || onlineKey(b.source, b.id),
        volumes: linkPrev(b.volumes ?? []),
        progress: b.progress ?? null,
        shelved: !!b.shelved,
        addedAt: b.addedAt ?? 0,
        readAt: b.readAt ?? 0,
        checkedAt: b.checkedAt ?? 0,
        newChapters: b.newChapters ?? 0,
        bookmarks: Array.isArray(b.bookmarks) ? b.bookmarks : [],
      }
    }
    // 读盘期间已经有改动（比如刚打开了一本书）：以内存里的为准
    useOnline.setState(s => ({
      loaded: true,
      books: { ...books, ...s.books },
    }))
  })())
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
let saving: Promise<void> = Promise.resolve()

function persist(now = false) {
  clearTimeout(saveTimer)
  const run = () => {
    const books = Object.values(useOnline.getState().books)
    const data: OnlineFile = { version: 1, books }
    // 去掉 prev.ref（对象引用，存进去会层层重复）
    const json = JSON.parse(JSON.stringify(data, (k, v) => (k === 'ref' ? undefined : v)))
    saving = saving.then(() => writeJSON(paths.online, json)).catch(e => console.error('在线书架保存失败', e))
    return saving
  }
  if (now) return run()
  saveTimer = setTimeout(run, 800)
  return saving
}

/** 立刻把还没写盘的改动写下去（离开阅读页时调用） */
export function flushOnline() {
  return persist(true)
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void flushOnline())
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void flushOnline())
}

function patchBook(key: string, fn: (b: OnlineBook) => OnlineBook | null) {
  useOnline.setState(s => {
    const cur = s.books[key]
    if (!cur) return s
    const next = fn(cur)
    const books = { ...s.books }
    if (next) books[key] = next
    else delete books[key]
    return { books }
  })
  persist()
}

/** 没收藏的书太多时，删掉最久没读的 */
function pruneLoose() {
  const loose = Object.values(useOnline.getState().books)
    .filter(b => !b.shelved)
    .sort((a, b) => b.readAt - a.readAt)
  if (loose.length <= MAX_LOOSE) return
  const drop = new Set(loose.slice(MAX_LOOSE).map(b => b.key))
  useOnline.setState(s => ({
    books: Object.fromEntries(Object.entries(s.books).filter(([k]) => !drop.has(k))),
  }))
}

/* ---------- 记录与书架 ---------- */

/** 书籍信息：SourceBook、搜索结果或已有记录都行，至少要有这几项 */
export type OnlineBookMeta = Pick<SourceBook, 'source' | 'id' | 'title'> & Partial<Pick<SourceBook, 'author' | 'cover' | 'description'>>

/**
 * 确保有这本书的记录，并更新书名、封面、目录快照（传了 volumes 时）。
 * 不会把书放上书架；返回记录的 key。
 */
export async function ensureOnlineBook(meta: OnlineBookMeta, volumes?: SourceVolume[]): Promise<string> {
  await loadOnline()
  const key = onlineKey(meta.source, meta.id)
  const cur = useOnline.getState().books[key]
  const vols = volumes?.length ? snapshot(volumes) : (cur?.volumes ?? [])
  const book: OnlineBook = {
    key,
    source: meta.source,
    id: meta.id,
    title: meta.title || cur?.title || '',
    author: meta.author ?? cur?.author ?? '',
    cover: meta.cover || cur?.cover || '',
    description: meta.description ?? cur?.description,
    volumes: vols,
    progress: cur?.progress ? relocate(cur.progress, vols) : null,
    shelved: cur?.shelved ?? false,
    addedAt: cur?.addedAt ?? 0,
    readAt: cur?.readAt ?? 0,
    checkedAt: volumes?.length ? Date.now() : (cur?.checkedAt ?? 0),
    newChapters: cur?.newChapters ?? 0,
    bookmarks: relocateMarks(cur?.bookmarks ?? [], vols),
  }
  useOnline.setState(s => ({ books: { ...s.books, [key]: book } }))
  persist()
  return key
}

/** 加入在线书架 */
export async function addToOnlineShelf(meta: OnlineBookMeta, volumes?: SourceVolume[]): Promise<string> {
  const key = await ensureOnlineBook(meta, volumes)
  patchBook(key, b => ({
    ...b,
    shelved: true,
    addedAt: b.addedAt || Date.now(),
  }))
  recordShelf(key)
  return key
}

/** 移出在线书架（进度先留着，再打开还能接着读；太久没读会被自动清掉） */
export async function removeFromOnlineShelf(key: string) {
  await loadOnline()
  patchBook(key, b => ({ ...b, shelved: false, addedAt: 0 }))
  recordShelf(key)
  pruneLoose()
  persist()
}

/** 收藏 / 取消收藏 */
export async function toggleOnlineShelf(meta: OnlineBookMeta, volumes?: SourceVolume[]): Promise<boolean> {
  await loadOnline()
  const key = onlineKey(meta.source, meta.id)
  if (useOnline.getState().books[key]?.shelved) {
    await removeFromOnlineShelf(key)
    return false
  }
  await addToOnlineShelf(meta, volumes)
  return true
}

/** 记录阅读进度（滚动时频繁调用也没关系，写盘有防抖） */
export function saveOnlineProgress(key: string, p: Omit<OnlineProgress, 'chapterId' | 'at'> & { chapterId?: string }) {
  patchBook(key, b => {
    const chapterId = p.chapterId ?? b.volumes[p.vol]?.chapters[p.ch]?.id ?? ''
    return {
      ...b,
      progress: {
        vol: p.vol,
        ch: p.ch,
        ratio: clamp01(p.ratio),
        block: p.block,
        chapterId,
        at: Date.now(),
      },
      readAt: Date.now(),
    }
  })
}

/** 打开阅读：记下阅读时间、清掉新章节角标 */
export function markOnlineOpened(key: string) {
  patchBook(key, b => ({ ...b, readAt: Date.now(), newChapters: 0 }))
  pruneLoose()
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

/** 目录变了以后，按章节 id 找回进度所在的卷和章 */
function relocate(p: OnlineProgress, volumes: SourceVolume[]): OnlineProgress {
  if (volumes[p.vol]?.chapters[p.ch]?.id === p.chapterId) return p
  for (let v = 0; v < volumes.length; v++) {
    const c = volumes[v].chapters.findIndex(x => x.id === p.chapterId)
    if (c >= 0) return { ...p, vol: v, ch: c }
  }
  // 找不到了：夹在目录范围内
  const vol = Math.max(0, Math.min(p.vol, volumes.length - 1))
  const ch = Math.max(0, Math.min(p.ch, (volumes[vol]?.chapters.length ?? 1) - 1))
  return {
    ...p,
    vol,
    ch,
    ratio: 0,
    block: undefined,
    chapterId: volumes[vol]?.chapters[ch]?.id ?? p.chapterId,
  }
}

/** 目录变了以后，按章节 id 找回各个书签所在的卷和章（找不到的章节，书签留在原序号上） */
function relocateMarks(marks: OnlineBookmark[], volumes: SourceVolume[]): OnlineBookmark[] {
  if (!marks.length || !volumes.length) return marks
  return marks.map(m => {
    if (volumes[m.vol]?.chapters[m.ch]?.id === m.chapterId) return m
    for (let v = 0; v < volumes.length; v++) {
      const c = volumes[v].chapters.findIndex(x => x.id === m.chapterId)
      if (c >= 0) return { ...m, vol: v, ch: c }
    }
    return m
  })
}

/* ---------- 书签 ---------- */

/** 加一个书签，返回它的 id */
export function addOnlineBookmark(key: string, m: Omit<OnlineBookmark, 'id' | 'at'>): string {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  patchBook(key, b => ({
    ...b,
    bookmarks: [...(b.bookmarks ?? []), { ...m, ratio: clamp01(m.ratio), id, at: Date.now() }],
  }))
  return id
}

/** 删掉一个书签 */
export function removeOnlineBookmark(key: string, id: string) {
  patchBook(key, b => ({ ...b, bookmarks: (b.bookmarks ?? []).filter(m => m.id !== id) }))
}

/** 书签按在书里的先后排序（目录顺序 → 章内位置） */
export function sortedBookmarks(b: OnlineBook): OnlineBookmark[] {
  return [...(b.bookmarks ?? [])].sort((x, y) => x.vol - y.vol || x.ch - y.ch || (x.block ?? -1) - (y.block ?? -1) || x.ratio - y.ratio)
}

/* ---------- 目录导航 ---------- */

export const chapterCount = (volumes: SourceVolume[]) => volumes.reduce((n, v) => n + v.chapters.length, 0)

export function chapterAt(volumes: SourceVolume[], pos: ChapterPos): SourceChapter | undefined {
  return volumes[pos.vol]?.chapters[pos.ch]
}

/** 全书第几章（从 0 开始） */
export function flatIndex(volumes: SourceVolume[], pos: ChapterPos): number {
  let n = 0
  for (let v = 0; v < pos.vol && v < volumes.length; v++) n += volumes[v].chapters.length
  return n + pos.ch
}

/** 下一章（跳过空卷）；已经是最后一章时返回 null */
export function nextPos(volumes: SourceVolume[], pos: ChapterPos): ChapterPos | null {
  if (pos.ch + 1 < (volumes[pos.vol]?.chapters.length ?? 0)) return { vol: pos.vol, ch: pos.ch + 1 }
  for (let v = pos.vol + 1; v < volumes.length; v++) if (volumes[v].chapters.length) return { vol: v, ch: 0 }
  return null
}

/** 上一章；已经是第一章时返回 null */
export function prevPos(volumes: SourceVolume[], pos: ChapterPos): ChapterPos | null {
  if (pos.ch > 0) return { vol: pos.vol, ch: pos.ch - 1 }
  for (let v = pos.vol - 1; v >= 0; v--) if (volumes[v].chapters.length) return { vol: v, ch: volumes[v].chapters.length - 1 }
  return null
}

/** 第一章（跳过空卷） */
export function firstPos(volumes: SourceVolume[]): ChapterPos | null {
  const v = volumes.findIndex(x => x.chapters.length)
  return v < 0 ? null : { vol: v, ch: 0 }
}

/** 进度描述：“第一卷 · 第三章” */
export function progressLabel(b: OnlineBook): string {
  if (!b.progress) return tr('还没开始读')
  const vol = b.volumes[b.progress.vol]
  const ch = vol?.chapters[b.progress.ch]
  if (!ch) return tr('还没开始读')
  return [vol.title, ch.title].filter(Boolean).join(' · ')
}

/* ---------- 章节正文：排队、缓存、预取 ---------- */

const aborted = () => new DOMException('cancelled', 'AbortError')

interface Job {
  run: () => Promise<ChapterContent>
  resolve: (c: ChapterContent) => void
  reject: (e: unknown) => void
  /** 还在等这个结果的人数；预取的任务算 1 个，直到被正式请求接手 */
  want: number
  key: string
}

/** 每个槽位一条队列（槽位一次只开一页） */
const queues = new Map<number, { busy: boolean; jobs: Job[] }>()

function pump(slot: number) {
  const q = queues.get(slot)!
  if (q.busy) return
  const job = q.jobs.shift()
  if (!job) return
  if (job.want <= 0) {
    // 没人要了：不开网页，结果也不进缓存
    chapterCache.delete(job.key)
    job.reject(aborted())
    pump(slot)
    return
  }
  q.busy = true
  job
    .run()
    .then(job.resolve, job.reject)
    .finally(() => {
      q.busy = false
      pump(slot)
    })
}

interface CacheEntry {
  promise: Promise<ChapterContent>
  job: Job
  done: boolean
}

/** 章节缓存：key 为 `${source}:${bookId}:${chapterId}`，最多留 CACHE_MAX 章 */
const chapterCache = new Map<string, CacheEntry>()
const CACHE_MAX = 16

function touch(key: string, e: CacheEntry) {
  chapterCache.delete(key)
  chapterCache.set(key, e)
  while (chapterCache.size > CACHE_MAX) {
    const oldest = chapterCache.keys().next().value as string
    const o = chapterCache.get(oldest)!
    // 还在排队、有人等着的不删
    if (!o.done && o.job.want > 0) break
    chapterCache.delete(oldest)
  }
}

function enqueue(source: BookSource, bookId: string, chapter: SourceChapter, slot: number, want: number): CacheEntry {
  const key = `${source.id}:${bookId}:${chapter.id}`
  const hit = chapterCache.get(key)
  if (hit) {
    hit.job.want += want
    touch(key, hit)
    return hit
  }
  let resolve!: (c: ChapterContent) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<ChapterContent>((a, b) => {
    resolve = a
    reject = b
  })
  // 不把 signal 传给书源：中途取消只会让槽位乱掉，抓完的结果反正可以缓存起来
  const job: Job = {
    run: () => source.getChapter(bookId, chapter, { slot }),
    resolve,
    reject,
    want,
    key,
  }
  const entry: CacheEntry = { promise, job, done: false }
  promise.then(
    () => (entry.done = true),
    () => chapterCache.get(key) === entry && chapterCache.delete(key), // 失败的不缓存，下次重试
  )
  if (!queues.has(slot)) queues.set(slot, { busy: false, jobs: [] })
  queues.get(slot)!.jobs.push(job)
  touch(key, entry)
  pump(slot)
  return entry
}

/** 正文用的槽位（与搜索共用）、预取用的槽位 */
export const READ_SLOT = 0
export const PREFETCH_SLOT = 1

/**
 * 取一章正文：有缓存直接给，没有就排队抓（slot 0）。
 * signal 取消后立刻返回 AbortError；还没开始抓的会被丢掉，已经在抓的抓完照样进缓存。
 */
export function getOnlineChapter(source: BookSource, bookId: string, chapter: SourceChapter, signal?: AbortSignal): Promise<ChapterContent> {
  if (signal?.aborted) return Promise.reject(aborted())
  const key = `${source.id}:${bookId}:${chapter.id}`
  const pre = chapterCache.get(key)
  // 预取还在排队（slot 1 前面有别的）：改到正文槽位上，别干等
  if (pre && !pre.done) {
    const q = queues.get(PREFETCH_SLOT)
    const i = q?.jobs.indexOf(pre.job) ?? -1
    if (i >= 0) {
      q!.jobs.splice(i, 1)
      if (!queues.has(READ_SLOT)) queues.set(READ_SLOT, { busy: false, jobs: [] })
      const job = pre.job
      job.run = () => source.getChapter(bookId, chapter, { slot: READ_SLOT })
      queues.get(READ_SLOT)!.jobs.unshift(job)
      pump(READ_SLOT)
    }
  }
  const entry = enqueue(source, bookId, chapter, READ_SLOT, 1)
  if (!signal) return entry.promise
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      entry.job.want = Math.max(0, entry.job.want - 1)
      reject(aborted())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    entry.promise.then(
      c => {
        signal.removeEventListener('abort', onAbort)
        resolve(c)
      },
      e => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/** 这一章已经抓好了吗（用来决定要不要显示“加载中”） */
export function isChapterCached(source: string, bookId: string, chapterId: string) {
  return !!chapterCache.get(`${source}:${bookId}:${chapterId}`)?.done
}

/**
 * 预取一章（slot 1）。有下载任务在跑时不预取：下载也在用这几个网页。
 * 预取的结果留在缓存里，翻到下一章时直接显示。
 */
export function prefetchOnlineChapter(source: BookSource, bookId: string, chapter: SourceChapter | undefined) {
  if (!chapter || activeDownloads.size) return
  const key = `${source.id}:${bookId}:${chapter.id}`
  if (chapterCache.has(key)) return
  const e = enqueue(source, bookId, chapter, PREFETCH_SLOT, 1)
  // 预取失败不用报错，正式打开时会再抓一次
  e.promise.catch(() => {})
  // 抓完就不算“有人在等”了，可以被新的缓存挤掉
  e.promise.finally(() => (e.job.want = 0)).catch(() => {})
}

/* ---------- 检查更新 ---------- */

export interface UpdateResult {
  key: string
  /** 这次新发现的章节数 */
  added: number
  error?: string
}

/** 检查一本书的更新：重新取目录，算出新章节数，换上新目录 */
export async function checkOnlineUpdate(key: string): Promise<UpdateResult> {
  await loadOnline()
  const b = useOnline.getState().books[key]
  if (!b) return { key, added: 0, error: tr('找不到这本书') }
  if (useOnline.getState().checking[key]) return { key, added: 0 }
  useOnline.setState(s => ({ checking: { ...s.checking, [key]: true } }))
  try {
    const vols = snapshot(await sourceOf(b.source).getVolumes(b.id))
    const before = chapterCount(b.volumes)
    const after = chapterCount(vols)
    // 第一次取到目录（之前快照是空的）不算“新章节”
    const added = before ? Math.max(0, after - before) : 0
    patchBook(key, cur => ({
      ...cur,
      volumes: vols,
      progress: cur.progress ? relocate(cur.progress, vols) : null,
      bookmarks: relocateMarks(cur.bookmarks ?? [], vols),
      checkedAt: Date.now(),
      newChapters: cur.newChapters + added,
    }))
    return { key, added }
  } catch (e) {
    return { key, added: 0, error: e instanceof Error ? e.message : String(e) }
  } finally {
    useOnline.setState(s => {
      const checking = { ...s.checking }
      delete checking[key]
      return { checking }
    })
  }
}

let checkingAll = false

/** 检查在线书架上所有书的更新（一本本来，不同时开很多网页） */
export async function checkAllOnlineUpdates(): Promise<{
  updated: number
  added: number
  failed: number
}> {
  await loadOnline()
  if (checkingAll) return { updated: 0, added: 0, failed: 0 }
  checkingAll = true
  const keys = Object.values(useOnline.getState().books)
    .filter(b => b.shelved)
    .map(b => b.key)
  let updated = 0
  let added = 0
  let failed = 0
  useOnline.setState({ checkAll: { done: 0, total: keys.length } })
  try {
    for (let i = 0; i < keys.length; i++) {
      const r = await checkOnlineUpdate(keys[i])
      if (r.error) failed++
      else if (r.added) {
        updated++
        added += r.added
      }
      useOnline.setState({ checkAll: { done: i + 1, total: keys.length } })
    }
  } finally {
    checkingAll = false
    useOnline.setState({ checkAll: null })
  }
  return { updated, added, failed }
}

/* ---------- 图片（封面、插图） ---------- */

/** 图片站有防盗链：交给 Rust 带上来源页下载，再变成 blob 地址。地址 → blob 地址 */
const imageCache = new Map<string, Promise<string>>()
const IMAGE_MAX = 240

export function loadOnlineImage(url: string, referer: string): Promise<string> {
  if (!url) return Promise.resolve('')
  let p = imageCache.get(url)
  if (p) {
    imageCache.delete(url)
    imageCache.set(url, p)
    return p
  }
  p = fetchImage(url, referer).then(img => (img ? URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.type })) : ''))
  // 没取到的不缓存，下次再试
  p.then(s => !s && imageCache.get(url) === p && imageCache.delete(url))
  imageCache.set(url, p)
  while (imageCache.size > IMAGE_MAX) {
    const oldest = imageCache.keys().next().value as string
    const o = imageCache.get(oldest)!
    imageCache.delete(oldest)
    // 稍后再释放：可能还有图片正显示着它
    o.then(s => s && setTimeout(() => URL.revokeObjectURL(s), 60_000))
  }
  return p
}

/** 取图片的 hook：返回 blob 地址（还没取到时为空字符串）和是否失败 */
export function useOnlineImage(url: string, source: string): { src: string; failed: boolean } {
  const [state, setState] = useState({ src: '', failed: false })
  useEffect(() => {
    setState({ src: '', failed: false })
    if (!url) return
    let alive = true
    let referer = ''
    try {
      referer = sourceOf(source).referer
    } catch {
      /* 未知书源：不带来源页试试 */
    }
    loadOnlineImage(url, referer).then(s => alive && setState({ src: s, failed: !s }))
    return () => {
      alive = false
    }
  }, [url, source])
  return state
}

/** 在线书架上的书（按上次阅读 / 收藏时间排序） */
export function useOnlineShelf(): OnlineBook[] {
  const books = useOnline(s => s.books)
  const loaded = useOnline(s => s.loaded)
  useEffect(() => {
    if (!loaded) void loadOnline()
  }, [loaded])
  return Object.values(books)
    .filter(b => b.shelved)
    .sort((a, b) => Math.max(b.readAt, b.addedAt) - Math.max(a.readAt, a.addedAt))
}

/** 某本书是否在在线书架上（书籍详情里的“加入在线书架”按钮用） */
export function useOnShelf(source: string, id: string): boolean {
  const loaded = useOnline(s => s.loaded)
  useEffect(() => {
    if (!loaded) void loadOnline()
  }, [loaded])
  return useOnline(s => !!s.books[onlineKey(source, id)]?.shelved)
}

/* ---------- 与书架记录对齐（同步） ---------- */

/**
 * 书架记录 → 在线书架：其他设备加入 / 移出的书在这里跟上；
 * 旧版本只存在本机的在线书架，补建成会同步的记录。
 */
function reconcile(library: BookRecord[]) {
  const books = useOnline.getState().books
  const next = { ...books }
  let changed = false
  const recs = new Map<string, BookRecord>()
  for (const r of library) {
    const o = r.online
    if (!o) continue
    const key = onlineKey(o.kind, o.id)
    recs.set(key, r)
    // 旧版本的记录：仅本机、标着有文件
    if (r.localOnly || r.hasFile) useStore.getState().putOnlineRecord(r)
    if (o.shelvedAt === undefined) continue
    const shelved = !!o.shelved && !r.deletedAt
    const cur = next[key]
    if (!cur) {
      if (!shelved) continue
      next[key] = {
        key,
        source: o.kind,
        id: o.id,
        title: r.title,
        author: r.author,
        cover: o.cover || '',
        volumes: [],
        progress: null,
        shelved: true,
        addedAt: o.shelvedAt,
        readAt: r.lastReadAt ?? 0,
        checkedAt: 0,
        newChapters: 0,
        bookmarks: [],
      }
      changed = true
    } else if (cur.shelved !== shelved) {
      next[key] = { ...cur, shelved, addedAt: shelved ? o.shelvedAt || cur.addedAt : 0 }
      changed = true
    }
  }
  if (changed) {
    useOnline.setState({ books: next })
    persist()
  }
  // 本机书架上有、记录上还没记的（旧版本加的）：补上
  for (const b of Object.values(next)) {
    const r = recs.get(b.key)
    if (b.shelved && r?.online?.shelvedAt === undefined) recordShelf(b.key)
  }
}

let reconcileTimer: ReturnType<typeof setTimeout> | undefined
function scheduleReconcile() {
  clearTimeout(reconcileTimer)
  reconcileTimer = setTimeout(async () => {
    await loadOnline()
    if (useStore.getState().ready) reconcile(useStore.getState().library)
  }, 400)
}
if (typeof window !== 'undefined') {
  useStore.subscribe((s, prev) => {
    if (s.library !== prev.library || s.ready !== prev.ready) scheduleReconcile()
  })
  scheduleReconcile()
}
