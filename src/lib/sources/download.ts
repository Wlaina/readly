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
import { appendEpub, buildEpub, editVolumes, imageType, readManifest, type EpubImage, type EpubVolume, type SourceManifest } from './epub'
import type { BookSource, ChapterContent, SourceBook, SourceChapter, SourceVolume } from './types'
import type { BookRecord, SourceRef } from '../types'
import { matchVolumes, styleVolTitle, tidyPlan, volStyle } from './update'

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
 * 书封摊开是“（折页）+ 封面 + 书脊 + 封底”，正封面在左侧（右侧是印着简介的封底）；
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
    const [left, right] = frontCoverSpan(bmp)
    const cw = right - left
    const canvas = new OffscreenCanvas(cw, h)
    canvas.getContext('2d')!.drawImage(bmp, left, 0, cw, h, 0, 0, cw, h)
    bmp.close()
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg' }
  } catch {
    return null
  }
}

/**
 * 在跨页书封里找正封面的左右边界。折线（折页、书脊的边）是从上到下贯穿整张图的颜色突变，
 * 找出这些竖线，取宽高比最像封面（高约为宽的 1.42 倍）的一段，差不多时取靠左的。
 * 找不到就退回从最左边裁一个封面宽度
 */
function frontCoverSpan(bmp: ImageBitmap): [number, number] {
  const { width: w, height: h } = bmp
  const fallback: [number, number] = [0, Math.min(w, Math.round(h / 1.42))]
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
  if (!ctx) return fallback
  ctx.drawImage(bmp, 0, 0)
  const px = ctx.getImageData(0, 0, w, h).data
  const lum = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) lum[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000
  // 每一列：和右边一列颜色差得明显的行占多少
  const lines = [0]
  for (let x = 0; x < w - 1; x++) {
    let n = 0
    for (let y = 0; y < h; y++) if (Math.abs(lum[y * w + x] - lum[y * w + x + 1]) > 18) n++
    if (n / h >= 0.4 && x + 1 - lines[lines.length - 1] > 10) lines.push(x + 1)
  }
  lines.push(w)
  let best: { cost: number; span: [number, number] } | null = null
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const ratio = h / (lines[j] - lines[i])
      if (ratio < 1.3 || ratio > 1.65) continue
      const cost = Math.abs(ratio - 1.42)
      if (!best || cost < best.cost - 0.03) best = { cost, span: [lines[i], lines[j]] }
    }
  return best?.span ?? fallback
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
/**
 * merge：追加到书架上已有的书。remote：这个书源上的完整目录——书原本是从另一个书源下载的（换书源追加）时要传，
 * 用来把书里已有的卷按卷号对应到这个书源，以后改按这个书源检查更新
 */
export async function downloadToShelf(
  src: BookSource,
  book: SourceBook,
  volumes: SourceVolume[],
  merge?: {
    hash: string
    toLast: SourceChapter[]
    remote?: SourceVolume[]
    /** 补到中间的卷：网站上的卷 id → 插到书里第几卷（位置）前面 */
    before?: Record<string, number>
  },
) {
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
      // 安卓实测：几个不挂在界面上的网页同时加载时会互相卡住（常常等到 30 秒超时），一次一个反而快得多。
      // 哔哩的正文是直接请求的（不开网页），可以几章同时下
      Array.from({ length: Math.min((window as any).ReadlyAndroid && src.id !== 'linovelib' ? 1 : BROWSER_SLOTS, total) }, async (_, slot) => {
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
      // 追更：读出书架上那本书，追加到末尾（或补到中间）
      const cur = store.library.find(b => b.hash === merge.hash && !b.deletedAt)
      if (!cur) throw new Error(tr('书架上找不到这本书了'))
      const old = await store.loadBookFile(cur)
      const read = readManifest(old)
      if (!read) throw new Error(tr('这本书不是从书库下载的，没法追更'))
      // 旧的书没记每卷的文件序号：那时只会往末尾追加，序号就是卷的位置
      let manifest: SourceManifest = { ...read, volumes: read.volumes.map((v, i) => ({ ...v, file: v.file ?? i })) }
      // 换书源（或以前换过、书里还记着另一个书源的卷 id）：已有的卷按卷号换成这个书源上的卷，以后按这个书源追更
      const remote = merge.remote ?? []
      const sameSrc = manifest.source === src.id && manifest.id === book.id
      const idx = matchVolumes(manifest, remote, { shelfTitle: cur.title, remoteTitle: book.title }, !sameSrc)
      manifest = {
        source: src.id,
        id: book.id,
        volumes: manifest.volumes.map((v, n) => {
          const r = remote[idx.indexOf(n)]
          if (!r || r.id === v.id) return v
          // 卷名保留书里原来的（只换成新书源的卷 id 和章节）
          return r ? { ...volEntry(r), title: v.title, file: v.file } : v
        }),
      }
      // 原来的封面是小缩略图（例如以前下载的书）而现在有更清楚的：顺手换掉
      const oldCover = Object.entries(unzipSync(old, { filter: f => /^OEBPS\/images\/cover\./.test(f.name) }))[0]?.[1]
      // 原来的封面太小，或者不是竖向的（以前可能选到了横向跨页图）：换成新的
      const oldOk = oldCover && oldCover.length * 2 > (bigCover?.bytes.length ?? 0) && (await isCoverShape({ bytes: oldCover, type: '' }))
      const better = bigCover && !oldOk ? bigCover : null
      const base = manifest
      const lastIdx = base.volumes.length - 1
      // 新卷的卷名按书里原有的样式（“第十五卷 短篇集”或“书名 15 短篇集”），不混用两个网站的叫法
      const style = volStyle(
        base.volumes.map(v => v.title),
        cur.title,
      )
      const named = (title: string) => styleVolTitle(title, book.title, style, cur.title)
      const outVols = (merge.toLast.length ? out.slice(1) : out).map(v => ({ ...v, title: named(v.title) }))
      // 补到中间的卷：插到书里那一卷前面
      const pos = volumes.map(v => merge.before?.[v.id])
      let merged = base
      const { bytes, remap } = appendEpub(
        old,
        {
          toLast: merge.toLast.length ? out[0].chapters : [],
          lastFile: base.volumes[lastIdx]?.file,
          volumes: outVols.map((v, k) => ({ ...v, before: pos[k] !== undefined ? base.volumes[pos[k]!]?.file : undefined })),
        },
        images,
        files => {
          const entry = (k: number) => ({ ...volEntry(volumes[k]), title: named(volumes[k].title), file: files[k] })
          const result: SourceManifest['volumes'] = []
          base.volumes.forEach((v, i) => {
            volumes.forEach((_, k) => pos[k] === i && result.push(entry(k)))
            result.push(i === lastIdx ? { ...v, chapters: [...v.chapters, ...merge.toLast.map(c => c.id)] } : v)
          })
          volumes.forEach((_, k) => pos[k] === undefined && result.push(entry(k)))
          merged = { ...base, volumes: result }
          return merged
        },
        better,
      )
      // 补到了中间：后面各章在书里的位置后移了，进度、书签、笔记跟着改
      if (remap.some((n, i) => n !== i)) store.remapBookPositions(cur.hash, remap)
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

/**
 * 整理书架上一本从书库下载的书：删掉重复的卷、卷名统一成一种样式。
 * 改的是书籍文件本身（写回书籍文件夹、上传云端），进度、书签、笔记的位置跟着改写
 */
export async function tidyBook(hash: string, remote?: { vols: SourceVolume[]; title: string }) {
  const store = useStore.getState()
  const cur = store.library.find(b => b.hash === hash && !b.deletedAt)
  if (!cur) return
  const old = await store.loadBookFile(cur)
  const read = readManifest(old)
  if (!read) throw new Error(tr('这本书不是从书库下载的'))
  // 书里记的卷 id 可能还是换书源前的：按卷号换成书架记录上的（记录跟着现在的书源）
  const rv = cur.source?.kind === read.source ? cur.source.volumes : []
  const ri = matchVolumes({ volumes: rv }, read.volumes, { shelfTitle: cur.title, remoteTitle: cur.title })
  const vols = read.volumes.map((v, i) => ({ ...v, id: ri[i] >= 0 ? rv[ri[i]].id : v.id, file: v.file ?? i }))
  const plan = tidyPlan(vols, cur.title, remote)
  if (!plan.remove.length && !plan.rename.size) {
    store.showToast(tr('《{title}》的卷已经很整齐了', { title: cur.title }))
    return
  }
  const manifest: SourceManifest = {
    ...read,
    volumes: vols.flatMap((v, i) => {
      if (plan.remove.includes(i)) return []
      const from = plan.takeFrom.get(i)
      return [
        {
          ...v,
          ...(from !== undefined ? { id: vols[from].id, chapters: vols[from].chapters } : {}),
          title: plan.rename.get(i) ?? v.title,
        },
      ]
    }),
  }
  const { bytes, remap } = editVolumes(
    old,
    {
      remove: plan.remove.map(i => vols[i].file),
      rename: Object.fromEntries([...plan.rename].map(([i, t]) => [vols[i].file, t])),
    },
    manifest,
  )
  if (remap.some((n, i) => n !== i)) store.remapBookPositions(hash, remap)
  await store.updateBookFile(hash, bytes, cur.fileName || `${cur.title}.epub`)
  await store.writeBookToFolder(hash, bytes)
  store.setBookSource(hash, { ...toSourceRef(manifest), checkedAt: undefined })
  const parts = [
    plan.remove.length && tr('删掉了 {n} 个重复的卷', { n: plan.remove.length }),
    plan.rename.size && tr('统一了 {n} 个卷名', { n: plan.rename.size }),
  ].filter(Boolean)
  store.showToast(tr('《{title}》已整理：{list}', { title: cur.title, list: parts.join('，') }))
}
