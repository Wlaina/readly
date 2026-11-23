/**
 * 追更：对比书架上已下载的卷（BookRecord.source）和网站上现在的目录，算出能追加的内容。
 * 只能往书的末尾追加（见 epub.ts 的 appendEpub），所以：
 * - 最后一卷新出的章节 → 接在最后一卷后面
 * - 排在已下载的最后一卷**之后**的新卷 → 追加
 * - 排在中间、当初没下载的卷 → 没法插到中间，标记出来
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
  /** 网站上每一卷的状态：已下载 / 可追加 / 在中间缺失 */
  status: ('have' | 'new' | 'gap')[]
  /** 最后一卷新出的章节 */
  toLast: SourceChapter[]
  /** 可以追加的新卷 */
  newVolumes: SourceVolume[]
}

const sameVol = (a: { id: string; title: string }, b: { id: string; title: string }) => a.id === b.id || (!!a.title && a.title === b.title)

export function planUpdate(ref: SourceRef, remote: SourceVolume[]): UpdatePlan {
  const idx = remote.map(v => ref.volumes.findIndex(r => sameVol(r, v)))
  const lastHave = Math.max(-1, ...idx.map((x, i) => (x >= 0 ? i : -1)))
  const status = remote.map((_, i) => (idx[i] >= 0 ? 'have' : i > lastHave ? 'new' : 'gap')) as UpdatePlan['status']
  let toLast: SourceChapter[] = []
  if (lastHave >= 0) {
    const known = ref.volumes[idx[lastHave]].chapters
    // 只有书里的最后一卷能接新章节
    if (idx[lastHave] === ref.volumes.length - 1) toLast = remote[lastHave].chapters.slice(known)
  }
  return {
    status,
    toLast,
    newVolumes: remote.filter((_, i) => status[i] === 'new'),
  }
}

/** 书架上从书库下载的书 */
export const sourceBooks = (library: BookRecord[]) => library.filter(b => !b.deletedAt && b.source)

/** 书架上找这本在线书 */
export const shelfBookOf = (library: BookRecord[], kind: string, id: string) => library.find(b => !b.deletedAt && b.source?.kind === kind && b.source.id === id)

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
