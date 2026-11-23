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
/** “十二”“二十一”“3”→ 数字 */
function toNum(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s)
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
 * 卷的“身份”：有卷号的按卷号（第一卷 / 书名 1 / Vol.1 都算第 1 卷），
 * 没有卷号的（短篇、番外…）按去掉书名后的卷名
 */
export function volKey(title: string, bookTitle: string): string {
  let t = norm(title)
  const bt = norm(bookTitle)
  if (bt && t.startsWith(bt)) t = t.slice(bt.length)
  const m = t.match(/第(\d+|[零〇一二两三四五六七八九十百]+)[卷册部集]/) ?? t.match(/^(?:vol|卷)?(\d+|[一二三四五六七八九十]+)$/)
  const n = m ? toNum(m[1]) : null
  return n != null ? `#${n}` : t
}

/** 同一本书在另一个书源上：书名一样，作者（两边都有时）也对得上 */
export function sameBook(a: { title: string; author: string }, b: { title: string; author: string }) {
  if (!a.title || norm(a.title) !== norm(b.title)) return false
  const x = norm(a.author)
  const y = norm(b.author)
  return !x || !y || x.includes(y) || y.includes(x)
}

/**
 * 网站上的卷对应到书里已有的哪一卷。同一个书源按卷 id；换了书源（cross）按卷号 / 卷名。
 * bookTitles：书里的书名、网站上的书名（卷名里常带着书名，比较前去掉）
 */
function matchVolumes(ref: SourceRef, remote: SourceVolume[], cross?: { shelfTitle: string; remoteTitle: string }) {
  if (!cross) return remote.map(v => ref.volumes.findIndex(r => sameVol(r, v)))
  const keys = ref.volumes.map(r => volKey(r.title, cross.shelfTitle))
  return remote.map(v => keys.indexOf(volKey(v.title, cross.remoteTitle)))
}

export function planUpdate(ref: SourceRef, remote: SourceVolume[], cross?: { shelfTitle: string; remoteTitle: string }): UpdatePlan {
  const idx = matchVolumes(ref, remote, cross)
  const lastHave = Math.max(-1, ...idx.map((x, i) => (x >= 0 ? i : -1)))
  const status = remote.map((_, i) => (idx[i] >= 0 ? 'have' : i > lastHave ? 'new' : 'gap')) as UpdatePlan['status']
  let toLast: SourceChapter[] = []
  if (lastHave >= 0) {
    const known = ref.volumes[idx[lastHave]].chapters
    // 只有书里的最后一卷能接新章节（换了书源时两边分章不一样，不接）
    if (!cross && idx[lastHave] === ref.volumes.length - 1) toLast = remote[lastHave].chapters.slice(known)
  }
  return {
    status,
    idx,
    toLast,
    newVolumes: remote.filter((_, i) => status[i] === 'new'),
  }
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
  const remoteKeys = remote.map(v => volKey(v.title, remoteTitle))
  return {
    ...ref,
    kind,
    id,
    volumes: ref.volumes.map(v => {
      const r = remote[remoteKeys.indexOf(volKey(v.title, shelfTitle))]
      return r ? { id: r.id, title: r.title, chapters: r.chapters.length } : v
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
        const plan = planUpdate(ref, remote)
        const cur = useStore.getState().library.find(x => x.hash === b.hash)
        if (!cur?.source) continue
        const newVolumes = plan.newVolumes.length
        const newChapters = plan.toLast.length
        if (newVolumes || newChapters) found++
        useStore.getState().setBookSource(b.hash, {
          ...cur.source,
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
