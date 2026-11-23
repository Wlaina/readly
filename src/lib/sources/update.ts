/**
 * 追更：对比书架上已下载的卷（BookRecord.source）和网站上现在的目录，算出能追加的内容。
 * 只能往书的末尾追加（见 epub.ts 的 appendEpub），所以：
 * - 最后一卷新出的章节 → 接在最后一卷后面
 * - 排在已下载的最后一卷**之后**的新卷 → 追加
 * - 排在中间、当初没下载的卷 → 可以补进去（插到后面那一卷前面，进度、书签、笔记的位置会跟着改写）
 *
 * 同一本书在两个书源上都有：按书名（和作者）认出书架上的书，卷按卷号对应（哔哩是“书名 1”，文库是“第一卷”），
 * 可以从另一个书源追加新卷；追加后（或手动选择后）以后的检查更新改用这个书源。
 */
import { create } from 'zustand'
import { useStore } from '../store'
import { tr } from '../i18n'
import type { BookRecord, SourceRef } from '../types'
import type { BookSource, SourceChapter, SourceVolume } from './types'
import { linovelib } from './linovelib'
import { wenku8 } from './wenku8'

const SOURCES: Record<string, BookSource> = { linovelib, wenku8 }
export const sourceOf = (kind: string) => SOURCES[kind]

export interface UpdatePlan {
  /** 网站上每一卷的状态：已下载 / 可追加 / 在中间缺失（可以补进去） */
  status: ('have' | 'new' | 'gap')[]
  /** 网站上每一卷对应书里第几卷（没有为 -1） */
  idx: number[]
  /** 最后一卷新出的章节 */
  toLast: SourceChapter[]
  /** 可以追加的新卷 */
  newVolumes: SourceVolume[]
}

const sameVol = (a: { id: string; title: string }, b: { id: string; title: string }) => a.id === b.id || (!!a.title && a.title === b.title)

/** 比较书名、作者用：去掉空白和常见标点，统一全角数字 */
const norm = (s: string) =>
  s
    .replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[\s·・:：\-—_()（）【】\[\]「」『』《》,，.。!！?？~～]/g, '')
    .toLowerCase()

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
/** “十二”“二十一”“3”“5点5”（5.5）→ 数字 */
function toNum(s: string): number | null {
  if (/^\d+(点\d+)?$/.test(s)) return Number(s.replace('点', '.'))
  let n = 0
  let cur = 0
  for (const c of s) {
    if (c === '十' || c === '百') {
      n += (cur || 1) * (c === '十' ? 10 : 100)
      cur = 0
    } else if (c in CN_DIGIT) cur = CN_DIGIT[c]
    else return null
  }
  return n + cur
}

/**
 * 卷的“身份”：有卷号的按卷号（第一卷 / 书名 1 / Vol.1 都算第 1 卷，5.5 卷算 5.5），
 * 没有卷号的（短篇、番外…）按去掉书名后的卷名
 */
export function volKey(title: string, bookTitle: string): string {
  return volParts(title, bookTitle).key
}

/** 卷号后面带副标题的也要分清：“5.5”和“5.5「恶魔呢喃」豪华册子”是两卷；比较用 full（卷号 + 副标题） */
export const volFull = (title: string, bookTitle: string) => {
  const p = volParts(title, bookTitle)
  return p.n == null ? p.key : `${p.key}|${norm(p.rest)}`
}

/** 小数点在 norm 里会被去掉（5.5 → 55），先换成“点” */
const keepDot = (s: string) => s.replace(/(\d)\s*[.．]\s*(\d)/g, '$1点$2')
const NUM = '(\d+(?:点\d+)?|[零〇一二两三四五六七八九十百]+)'
const RE_CN = new RegExp(`^(.*?)第${NUM}[卷册部集](.*)$`)
const RE_PLAIN = /^()(?:vol|卷)?(\d+(?:点\d+)?|[一二三四五六七八九十]+)(?![\d点])(.*)$/

/**
 * 拆开卷名：卷号 n（没有为 null）、卷号后面的副标题 rest（例如“短篇集”）、比较用的 key，
 * 以及卷名里「」『』括起来的小标题 quote（特典小册子常靠它对上：“「恶魔呢喃」短篇集册子”和“5.5「恶魔呢喃」豪华册子”）。
 * “第十五卷 短篇集”“魔女之旅 15 短篇集”“Vol.15 短篇集”都是第 15 卷、副标题“短篇集”
 */
export function volParts(title: string, bookTitle: string): { n: number | null; rest: string; key: string; quote: string } {
  let t = norm(keepDot(title))
  const bt = norm(keepDot(bookTitle))
  if (bt && t.startsWith(bt)) t = t.slice(bt.length)
  const q = title.match(/[「『]([^」』]+)[」』]/)
  const quote = q ? norm(q[1]) : ''
  const m = t.match(RE_CN) ?? t.match(RE_PLAIN)
  const n = m ? toNum(m[2]) : null
  if (n == null) return { n: null, rest: '', key: t, quote }
  // 副标题用原文（norm 去掉了空格标点）：去掉书名，取卷号之后的部分
  let raw = title.replace(/\s+/g, ' ').trim()
  const rawBt = bookTitle.replace(/\s+/g, ' ').trim()
  if (rawBt && raw.startsWith(rawBt)) raw = raw.slice(rawBt.length)
  const after = raw.match(/(?:第\s*(?:\d+(?:\s*[.．]\s*\d+)?|[零〇一二两三四五六七八九十百]+)\s*[卷册部集]|(?:vol\.?|卷)?\s*\d+(?:\s*[.．]\s*\d+)?|[一二三四五六七八九十]+$)\s*(.*)$/i)
  return { n, rest: m![3] ? (after?.[1] ?? '').trim() : '', key: `#${n}`, quote }
}

/** 卷名统一成书里原有的样式：“第十五卷 短篇集”或“书名 15 短篇集” */
const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
export function cnNum(n: number): string {
  if (!Number.isInteger(n)) return String(n)
  if (n < 10) return CN[n]
  if (n < 20) return '十' + (n % 10 ? CN[n % 10] : '')
  if (n < 100) return CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : '')
  return String(n)
}
export type VolStyle = 'cn' | 'title'
/** 书里卷名的样式：多数是“第N卷”还是“书名 N” */
export function volStyle(titles: string[], bookTitle: string): VolStyle | null {
  let cn = 0
  let num = 0
  for (const t of titles) {
    if (volParts(t, bookTitle).n == null) continue
    if (/第\s*(\d+|[零〇一二两三四五六七八九十百]+)\s*[卷册部集]/.test(t)) cn++
    else num++
  }
  return cn || num ? (cn >= num ? 'cn' : 'title') : null
}
/** 按样式改写卷名（没有卷号的卷名不动） */
export function styleVolTitle(title: string, srcBookTitle: string, style: VolStyle | null, bookTitle: string): string {
  const p = volParts(title, srcBookTitle)
  if (p.n == null || !style) return title
  const head = style === 'cn' ? `第${cnNum(p.n)}卷` : `${bookTitle} ${p.n}`
  if (!p.rest) return head
  // 副标题以「」开头的不加空格：“书名 5.5「恶魔呢喃」豪华册子”
  return /^[「『]/.test(p.rest) ? head + p.rest : `${head} ${p.rest}`
}

/** 同一本书在另一个书源上：书名一样，作者（两边都有时）也对得上 */
export function sameBook(a: { title: string; author: string }, b: { title: string; author: string }) {
  if (!a.title || norm(a.title) !== norm(b.title)) return false
  const x = norm(a.author)
  const y = norm(b.author)
  return !x || !y || x.includes(y) || y.includes(x)
}

/**
 * 网站上的卷对应到书里已有的哪一卷（没有为 -1），一卷只对一卷。按把握从大到小：
 * 1. 同一个书源：卷 id（或卷名）一样
 * 2. 卷号和副标题都一样（“第十五卷 短篇集” = “魔女之旅 15 短篇集”；没卷号的按卷名）
 * 3. 「」里的小标题一样（“「天使细语」豪华小册子” = “11.5「天使细语」豪华小册子”）
 * 4. 卷号一样、有一边没副标题（“第十五卷” = “魔女之旅 15 短篇集”）
 * 换了书源（cross）不比卷 id。titles：书里的书名、网站上的书名（卷名里常带着书名，比较前去掉）
 */
export function matchVolumes(ref: { volumes: { id: string; title: string }[] }, remote: { id: string; title: string }[], titles?: VolTitles, cross = false) {
  const idx = remote.map(() => -1)
  const used = new Set<number>()
  const pass = (same: (i: number, n: number) => boolean) =>
    remote.forEach((_, i) => {
      if (idx[i] >= 0) return
      const n = ref.volumes.findIndex((_, n) => !used.has(n) && same(i, n))
      if (n >= 0) {
        idx[i] = n
        used.add(n)
      }
    })
  if (!cross) pass((i, n) => sameVol(ref.volumes[n], remote[i]))
  if (!titles) return idx
  const rp = remote.map(v => volParts(v.title, titles.remoteTitle))
  const sp = ref.volumes.map(v => volParts(v.title, titles.shelfTitle))
  const full = (p: ReturnType<typeof volParts>) => (p.n == null ? p.key : `${p.key}|${norm(p.rest)}`)
  pass((i, n) => full(rp[i]) === full(sp[n]))
  pass((i, n) => !!rp[i].quote && rp[i].quote === sp[n].quote)
  pass((i, n) => rp[i].n != null && rp[i].key === sp[n].key && (!rp[i].rest || !sp[n].rest))
  return idx
}

export type VolTitles = { shelfTitle: string; remoteTitle: string }

export function planUpdate(ref: SourceRef, remote: SourceVolume[], titles?: VolTitles, cross = false): UpdatePlan {
  const idx = matchVolumes(ref, remote, titles, cross)
  const lastHave = Math.max(-1, ...idx.map((x, i) => (x >= 0 ? i : -1)))
  const status = remote.map((_, i) => (idx[i] >= 0 ? 'have' : i > lastHave ? 'new' : 'gap')) as UpdatePlan['status']
  let toLast: SourceChapter[] = []
  if (lastHave >= 0) {
    const known = ref.volumes[idx[lastHave]].chapters
    // 只有书里的最后一卷能接新章节（按卷号对上的两边分章可能不一样，不接）
    const sameId = sameVol(ref.volumes[idx[lastHave]], remote[lastHave])
    if (!cross && sameId && idx[lastHave] === ref.volumes.length - 1) toLast = remote[lastHave].chapters.slice(known)
  }
  return {
    status,
    idx,
    toLast,
    newVolumes: remote.filter((_, i) => status[i] === 'new'),
  }
}

/**
 * 书架记录上的卷 id 和网站对不上、但卷号对得上的（换过书源留下的旧卷 id）：换成网站上的卷 id，
 * 以后按 id 就能认出来。没有要改的返回 null
 */
export function healRef(ref: SourceRef, remote: SourceVolume[], titles: VolTitles): SourceRef | null {
  const idx = matchVolumes(ref, remote, titles)
  let changed = false
  const volumes = ref.volumes.map((v, n) => {
    const i = idx.indexOf(n)
    if (i < 0 || remote[i].id === v.id) return v
    changed = true
    return { ...v, id: remote[i].id }
  })
  return changed ? { ...ref, volumes } : null
}

/** 书架上从书库下载的书 */
export const sourceBooks = (library: BookRecord[]) => library.filter(b => !b.deletedAt && b.source)

/** 书架上找这本在线书（同一个书源下载的） */
export const shelfBookOf = (library: BookRecord[], kind: string, id: string) => library.find(b => !b.deletedAt && b.source?.kind === kind && b.source.id === id)

/** 书架上的同一本书：先找同一个书源的；没有就找从另一个书源下载的同名书（cross） */
export function findShelfBook(
  library: BookRecord[],
  kind: string,
  id: string,
  meta?: { title: string; author: string },
): { rec: BookRecord; cross: boolean } | null {
  const same = shelfBookOf(library, kind, id)
  if (same) return { rec: same, cross: false }
  if (!meta) return null
  const other = sourceBooks(library).find(b => b.source!.kind !== kind && sameBook(b, meta))
  return other ? { rec: other, cross: true } : null
}

/**
 * 换书源：把书架记录上的来源换成这个书源（已有的卷按卷号换成新书源上的卷，以后按它检查更新）。
 * 下载追加时也用它算新的卷列表
 */
export function crossRef(ref: SourceRef, shelfTitle: string, kind: string, id: string, remote: SourceVolume[], remoteTitle: string): SourceRef {
  const idx = matchVolumes(ref, remote, { shelfTitle, remoteTitle }, true)
  return {
    ...ref,
    kind,
    id,
    volumes: ref.volumes.map((v, n) => {
      const r = remote[idx.indexOf(n)]
      // 卷名保留书里原来的
      return r ? { id: r.id, title: v.title, chapters: r.chapters.length } : v
    }),
    checkedAt: undefined,
    newVolumes: 0,
    newChapters: 0,
  }
}

export const useUpdateCheck = create<{
  running: boolean
  done: number
  total: number
}>(() => ({ running: false, done: 0, total: 0 }))

/**
 * 检查书架上从书库下载的书有没有更新（一本一本查，查完记在书架记录上，随同步到其他设备）。
 * onlyStale：只查超过 12 小时没查过的（进入书库页时自动查用）
 */
export async function checkUpdates(onlyStale = false) {
  if (useUpdateCheck.getState().running) return
  const store = useStore.getState()
  const books = sourceBooks(store.library).filter(b => !onlyStale || Date.now() - (b.source!.checkedAt ?? 0) > 12 * 3600_000)
  if (!books.length) return
  useUpdateCheck.setState({ running: true, done: 0, total: books.length })
  let found = 0
  try {
    for (const [i, b] of books.entries()) {
      const ref = b.source!
      const src = sourceOf(ref.kind)
      if (!src) continue
      try {
        const remote = await src.getVolumes(ref.id)
        const plan = planUpdate(ref, remote, { shelfTitle: b.title, remoteTitle: b.title })
        const cur = useStore.getState().library.find(x => x.hash === b.hash)
        if (!cur?.source) continue
        const healed = healRef(cur.source, remote, { shelfTitle: b.title, remoteTitle: b.title })
        const newVolumes = plan.newVolumes.length
        const newChapters = plan.toLast.length
        if (newVolumes || newChapters) found++
        useStore.getState().setBookSource(b.hash, {
          ...(healed ?? cur.source),
          checkedAt: Date.now(),
          newVolumes,
          newChapters,
        })
      } catch (e) {
        console.warn('检查更新失败', b.title, e)
      }
      useUpdateCheck.setState({ done: i + 1 })
    }
  } finally {
    useUpdateCheck.setState({ running: false })
  }
  if (found) useStore.getState().showToast(tr('书库：{n} 本书有更新', { n: found }))
  else if (!onlyStale) useStore.getState().showToast(tr('书库：都是最新的'))
}

/**
 * 整理书里的卷：同一卷出现两次（例如换书源后又补了一遍）只留排在前面的那份，
 * 卷 id 和章节取最后加的那份（它来自现在追更的书源）；卷名统一成书里多数卷的样式。
 * 返回要删掉的卷的位置、留下的卷从哪一卷取 id，以及要改的卷名（位置 → 新卷名）
 */
export function tidyPlan(vols: { id?: string; title: string }[], bookTitle: string, remote?: { vols: { id: string; title: string }[]; title: string }) {
  const firstAt = new Map<string, number>()
  const remove: number[] = []
  const takeFrom = new Map<number, number>()
  vols.forEach((v, i) => {
    // 卷号和副标题都一样才算重复（“5.5”和“5.5「恶魔呢喃」豪华册子”是两卷）
    const k = volFull(v.title, bookTitle)
    const f = firstAt.get(k)
    if (f === undefined) firstAt.set(k, i)
    else {
      remove.push(i)
      takeFrom.set(f, i)
    }
  })
  const style = volStyle(
    vols.map(v => v.title),
    bookTitle,
  )
  // 和网站上卷 id 一样、卷号却不一样的卷：卷名照网站上的重新写（修好以前整理时弄坏的卷名，例如 5.5 变成了 55）
  const byId = new Map(remote?.vols.map(v => [v.id, v.title]))
  const rename = new Map<number, string>()
  vols.forEach((v, i) => {
    if (remove.includes(i)) return
    const site = v.id ? byId.get(v.id) : undefined
    const n = volParts(v.title, bookTitle).n
    const fix = site && n != null && n !== volParts(site, remote!.title).n
    const t = fix ? styleVolTitle(site, remote!.title, style, bookTitle) : styleVolTitle(v.title, bookTitle, style, bookTitle)
    if (t !== v.title) rename.set(i, t)
  })
  return { remove, takeFrom, rename }
}
