/**
 * 从书源下载选中的卷，打包成 EPUB 加入书架（之后同步、存入书籍文件夹都走原有流程）。
 * 用几个隐藏网页并行抓章节（每个网页一次只开一页），章与章之间稍作停顿，不给网站添负担。
 * 进度放在 useDownloads 里，书库页面显示并可以取消。
 */
import { invoke } from '@tauri-apps/api/core'
import { unzipSync } from 'fflate'
import { create } from 'zustand'
import { endTask, startTask, taskControls, updateTask } from '../tasks'
import { useStore } from '../store'
import { setKeepScreenOn } from '../native'
import { tr } from '../i18n'
import { BROWSER_SLOTS, cancelBrowser } from './browser'
import { appendEpub, buildEpub, imageType, readManifest, type EpubImage, type EpubVolume, type SourceManifest } from './epub'
import type { BookSource, ChapterContent, SourceBook, SourceChapter, SourceVolume } from './types'
import type { BookRecord, SourceRef } from '../types'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const aborted = () => new DOMException('cancelled', 'AbortError')

export async function fetchImage(url: string, referer: string): Promise<EpubImage | null> {
  if (!url) return null
  // 哔哩的封面有时放在姊妹站 bilinovel 上，防盗链要按图片所在的站点来
  const ref = /bilinovel\./.test(url) ? 'https://www.bilinovel.com/' : referer
  try {
    const buf = await invoke<ArrayBuffer>('fetch_image', { url, referer: ref })
    const bytes = new Uint8Array(buf)
    const t = imageType(bytes)
    return t ? { bytes, type: t.mime } : null
  } catch (e) {
    console.warn('图片下载失败', url, e)
    return null
  }
}

/**
 * 把一张图变成封面：竖向的直接用；横向的跨页书封裁出正封面。日式轻小说从右往左翻，
 * 书封摊开是“封面 + 书脊 + 封底”，正封面在左侧（右侧是印着简介的封底）；
 * 其他（太小、比例奇怪）返回 null
 */
export async function asCover(img: EpubImage): Promise<EpubImage | null> {
  if (await isCoverShape(img)) return img
  try {
    const bmp = await createImageBitmap(new Blob([img.bytes as BlobPart]))
    const { width: w, height: h } = bmp
    if (h < 400 || w / h < 1.3) {
      bmp.close()
      return null
    }
    const cw = Math.round(h / 1.42)
    const canvas = new OffscreenCanvas(cw, h)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, cw, h, 0, 0, cw, h)
    bmp.close()
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg' }
  } catch {
    return null
  }
}

/** 适合当封面：竖向（高是宽的 1.2 ~ 1.8 倍），而且不是太小的缩略图 */
async function isCoverShape(img: EpubImage): Promise<boolean> {
  try {
    const bmp = await createImageBitmap(new Blob([img.bytes as BlobPart]))
    const { width: w, height: h } = bmp
    bmp.close()
    return w >= 200 && h / w >= 1.2 && h / w <= 1.8
  } catch {
    return false
  }
}

export interface DownloadState {
  key: string
  title: string
  done: number
  total: number
  failed: number
  stage: 'chapters' | 'images' | 'saving'
  paused?: boolean
}

export const useDownloads = create<{ list: DownloadState[] }>(() => ({
  list: [],
}))
const patch = (key: string, p: Partial<DownloadState>) =>
  useDownloads.setState(s => ({
    list: s.list.map(d => (d.key === key ? { ...d, ...p } : d)),
  }))

/** 正在进行的下载（书源:书号 → 取消用的控制器），同一本书不会重复下载 */
export const activeDownloads = new Map<string, AbortController>()

/**
 * 安卓：下载期间开前台服务（通知栏进度 + 唤醒锁），切后台、熄屏后继续下载；全部结束后关掉。
 * 电脑端没有这个限制，什么也不做。
 */
let bgAt = 0
function backgroundWork(force = false) {
  const b = (window as any).ReadlyAndroid
  if (!b?.setBackgroundWork) return
  const list = useDownloads.getState().list
  if (!list.length) {
    b.setBackgroundWork('')
    // 下载完了：屏幕常亮交还给阅读器的设置（正在读书且开着“常亮”就保持）
    const st = useStore.getState()
    if (!(st.reading && st.settings.keepAwake)) setKeepScreenOn(false)
    return
  }
  // 安卓熄屏后网页会被系统整个挂起，下载就停了：下载期间保持屏幕常亮（手动锁屏则暂停，亮屏后自动继续）
  if (force) setKeepScreenOn(true)
  const now = Date.now()
  if (!force && now - bgAt < 1500) return
  bgAt = now
  const d = list[0]
  const more = list.length > 1 ? tr('（另有 {n} 本）', { n: list.length - 1 }) : ''
  b.setBackgroundWork(`《${d.title}》 ${d.done} / ${d.total}${d.paused ? tr('（已暂停）') : ''}${more}`)
}

/** 暂停中的下载：正在抓的那一章抓完就停下，继续时接着往下抓 */
const pausedKeys = new Set<string>()
const taskOf = new Map<string, string>()

export function pauseDownload(key: string, on: boolean) {
  if (!activeDownloads.has(key)) return
  if (on) pausedKeys.add(key)
  else pausedKeys.delete(key)
  patch(key, { paused: on })
  backgroundWork(true)
  const tid = taskOf.get(key)
  if (tid) updateTask(tid, { paused: on })
}

export function cancelDownload(key: string) {
  const c = activeDownloads.get(key)
  if (!c) return
  c.abort()
  // 隐藏网页里正在加载的页也停掉（搜索用的网页也会被一起停下，影响不大）
  cancelBrowser()
}

async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal, times = 3): Promise<T> {
  let last: unknown
  for (let i = 0; i < Math.max(times, 4); i++) {
    if (signal.aborted) throw aborted()
    try {
      return await fn()
    } catch (e) {
      if (signal.aborted) throw aborted()
      last = e
      // 被网站限流时多等一会儿
      const blocked = /拒绝访问/.test(String((e as Error)?.message ?? e))
      await sleep((blocked ? 5000 : 1500) * (i + 1))
    }
  }
  throw last
}

/**
 * 下载到书架。
 * - 不传 merge：下载选中的卷，打包成一本新书加入书架。
 * - 传 merge（追更）：把最后一卷新出的章节（merge.toLast）和新的卷（volumes）追加到书架上已有的那本书末尾，
 *   书架记录不变（阅读进度、书签、笔记都保留），新文件照常同步到其他设备。
 */
export async function downloadToShelf(src: BookSource, book: SourceBook, volumes: SourceVolume[], merge?: { hash: string; toLast: SourceChapter[] }) {
  const key = `${src.id}:${book.id}`
  if (activeDownloads.has(key)) throw new Error(tr('这本书正在下载'))
  const ctrl = new AbortController()
  const signal = ctrl.signal
  activeDownloads.set(key, ctrl)
  // 第 0 组是追加到最后一卷的新章节（追更时才有），后面是整卷
  const groups: { title: string; chapters: SourceChapter[] }[] = [
    ...(merge?.toLast.length ? [{ title: '', chapters: merge.toLast }] : []),
    ...volumes.map(v => ({ title: v.title, chapters: v.chapters })),
  ]
  const jobs = groups.flatMap((g, gi) => g.chapters.map((ch, ci) => ({ gi, ci, ch, title: g.title })))
  const total = jobs.length
  useDownloads.setState(s => ({
    list: [...s.list, { key, title: book.title, done: 0, total, failed: 0, stage: 'chapters' }],
  }))
  backgroundWork(true)
  const tid = startTask('download', merge ? tr('追更《{title}》', { title: book.title }) : tr('《{title}》', { title: book.title }), {
    total,
    loaded: 0,
    unit: 'items',
  })
  taskOf.set(key, tid)
  taskControls.set(tid, {
    cancel: () => cancelDownload(key),
    pause: () => pauseDownload(key, true),
    resume: () => pauseDownload(key, false),
  })
  try {
    // 按组、章的位置放结果，并行抓完后顺序不乱
    const contents: ChapterContent[][] = groups.map(g => new Array(g.chapters.length))
    let next = 0
    let done = 0
    let failed = 0
    await Promise.all(
      // 安卓实测：几个不挂在界面上的网页同时加载时会互相卡住（常常等到 30 秒超时），一次一个反而快得多
      Array.from({ length: Math.min((window as any).ReadlyAndroid ? 1 : BROWSER_SLOTS, total) }, async (_, slot) => {
        while (next < jobs.length) {
          while (pausedKeys.has(key) && !signal.aborted) await sleep(400)
          if (signal.aborted) throw aborted()
          const { gi, ci, ch, title } = jobs[next++]
          let content: ChapterContent
          try {
            content = await withRetry(() => src.getChapter(book.id, ch, { slot, signal }), signal)
          } catch (e) {
            if (signal.aborted) throw aborted()
            console.warn('章节下载失败', ch.title, e)
            failed++
            content = {
              title: ch.title,
              blocks: [{ type: 'p', text: tr('（本章下载失败）') }],
            }
          }
          contents[gi][ci] = content
          done++
          patch(key, { done, failed })
          updateTask(tid, {
            loaded: done,
            detail: title ? `${title} · ${ch.title}` : ch.title,
          })
          backgroundWork()
          // 每页之间的间隔由 browser.ts 按网站限速
          // 不用定时器停顿：应用在后台时网页的定时器会被系统大幅放慢，同时开的网页数已经限制了频率
        }
      }),
    )
    const out: EpubVolume[] = groups.map((g, gi) => ({
      title: g.title,
      chapters: g.chapters.map((ch, ci) => ({
        id: ch.id,
        title: ch.title,
        content: contents[gi][ci],
      })),
    }))

    // 插图与封面
    const srcs = [...new Set(out.flatMap(v => v.chapters.flatMap(c => c.content.blocks.flatMap(b => (b.type === 'img' ? [b.src] : [])))))]
    const images = new Map<string, EpubImage>()
    patch(key, { stage: 'images' })
    updateTask(tid, {
      loaded: done,
      detail: tr('下载插图 {n} 张', { n: srcs.length }),
    })
    let i = 0
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (i < srcs.length && !signal.aborted) {
          const url = srcs[i++]
          const img = await fetchImage(url, src.referer)
          if (img) images.set(url, img)
        }
      }),
    )
    if (signal.aborted) throw aborted()

    // 高清封面：哔哩用目录页上这一卷的大封面；文库用“插图”章节里的图。
    // 只要竖向的图（插图里常有横向的跨页彩图，放进封面框会被裁歪）；都没有才用书页上的小图
    const isIllus = (t: string) => /插图|插畫/.test(t)
    const candidates = [
      ...volumes.flatMap(v => (v.cover ? [v.cover] : [])),
      ...out
        .flatMap(v => v.chapters)
        .filter(c => isIllus(c.title))
        .flatMap(c => c.content.blocks.flatMap(b => (b.type === 'img' ? [b.src] : []))),
    ]
    let bigCover: EpubImage | null = null
    for (const url of candidates.slice(0, 12)) {
      const img = images.get(url) ?? (await fetchImage(url, src.referer))
      bigCover = img && (await asCover(img))
      if (bigCover) break
    }

    patch(key, { stage: 'saving' })
    const store = useStore.getState()
    const name = `${book.title}.epub`
    const volEntry = (v: SourceVolume) => ({
      id: v.id,
      title: v.title,
      chapters: v.chapters.map(c => c.id),
    })
    let rec: BookRecord | undefined
    if (merge) {
      // 追更：读出书架上那本书，在末尾追加
      const cur = store.library.find(b => b.hash === merge.hash && !b.deletedAt)
      if (!cur) throw new Error(tr('书架上找不到这本书了'))
      const old = await store.loadBookFile(cur)
      const manifest = readManifest(old)
      if (!manifest) throw new Error(tr('这本书不是从书库下载的，没法追更'))
      const last = manifest.volumes[manifest.volumes.length - 1]
      const merged: SourceManifest = {
        ...manifest,
        volumes: [
          ...manifest.volumes.slice(0, -1),
          ...(last
            ? [
                {
                  ...last,
                  chapters: [...last.chapters, ...merge.toLast.map(c => c.id)],
                },
              ]
            : []),
          ...volumes.map(volEntry),
        ],
      }
      // 原来的封面是小缩略图（例如以前下载的书）而现在有更清楚的：顺手换掉
      const oldCover = Object.entries(unzipSync(old, { filter: f => /^OEBPS\/images\/cover\./.test(f.name) }))[0]?.[1]
      // 原来的封面太小，或者不是竖向的（以前可能选到了横向跨页图）：换成新的
      const oldOk = oldCover && oldCover.length * 2 > (bigCover?.bytes.length ?? 0) && (await isCoverShape({ bytes: oldCover, type: '' }))
      const better = bigCover && !oldOk ? bigCover : null
      const bytes = appendEpub(
        old,
        { toLast: merge.toLast.length ? out[0].chapters : [], volumes: merge.toLast.length ? out.slice(1) : out },
        images,
        merged,
        better,
      )
      await store.updateBookFile(cur.hash, bytes, name)
      await store.writeBookToFolder(cur.hash, bytes)
      store.setBookSource(cur.hash, toSourceRef(merged))
      rec = store.library.find(b => b.hash === cur.hash)
    } else {
      const cover = bigCover ?? (await fetchImage(book.cover, src.referer))
      const manifest: SourceManifest = {
        source: src.id,
        id: book.id,
        volumes: volumes.map(volEntry),
      }
      const bookUrl = src.id === 'wenku8' ? `${src.home}/book/${book.id}.htm` : `${src.home}/novel/${book.id}.html`
      const bytes = buildEpub(book, bookUrl, out, images, cover, manifest)
      ;[rec] = await store.importFiles([new File([bytes as BlobPart], name, { type: 'application/epub+zip' })], { silent: true })
      if (rec) store.setBookSource(rec.hash, toSourceRef(manifest))
    }
    endTask(tid)
    const missing = srcs.length - images.size
    const notes = [failed && tr('{n} 章下载失败', { n: failed }), missing && tr('{n} 张插图没下载到', { n: missing })].filter(Boolean)
    const head = merge
      ? tr('《{title}》已追加 {n} 章', {
          title: rec?.title ?? book.title,
          n: total,
        })
      : tr('《{title}》已加入书架', { title: rec?.title ?? book.title })
    store.showToast(head + (notes.length ? tr('（{list}）', { list: notes.join('，') }) : ''))
    return rec
  } catch (e) {
    endTask(tid, signal.aborted ? tr('已取消') : e)
    if (signal.aborted) useStore.getState().showToast(tr('已取消下载《{title}》', { title: book.title }))
    throw e
  } finally {
    activeDownloads.delete(key)
    pausedKeys.delete(key)
    taskControls.delete(tid)
    taskOf.delete(key)
    useDownloads.setState(s => ({
      list: s.list.filter(d => d.key !== key),
    }))
    backgroundWork(true)
  }
}

/** 书架记录上记的来源（随书架同步）：书源、书号、各卷 id 与章数 */
export function toSourceRef(m: SourceManifest): SourceRef {
  return {
    kind: m.source,
    id: m.id,
    volumes: m.volumes.map(v => ({
      id: v.id,
      title: v.title,
      chapters: v.chapters.length,
    })),
    mergedAt: Date.now(),
  }
}
