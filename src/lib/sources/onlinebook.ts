/**
 * 在线阅读用主阅读器打开：给阅读引擎一本“虚拟书”。
 * 目录是网站上的章节（按卷分组），翻到哪一章才去抓哪一章（插图一起取回），抓过的章节有缓存，下一章会预先抓好。
 * 书架上有一条隐藏的记录（BookRecord.online，只存在本机、不同步），进度、书签、划线、笔记、统计都记在它上面，
 * 和本地书用的是同一套阅读器、同一套外观与操作。
 */
import { useStore } from '../store'
import { tr } from '../i18n'
import type { BookRecord } from '../types'
import type { ChapterBlock, SourceChapter, SourceVolume } from './types'
import {
  ensureOnlineBook,
  getOnlineChapter,
  loadOnlineImage,
  markOnlineOpened,
  onlineKey,
  prefetchOnlineChapter,
  saveOnlineProgress,
  sourceOf,
  useOnline,
  type OnlineBookMeta,
} from './online'

export const onlineHash = (source: string, id: string) => `online-${source}-${id}`

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const page = (title: string, body: string) =>
  `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title>` +
  `<style>h1,h2{text-align:center;text-indent:0;margin:1.2em 0 1em}div.illus{text-align:center;text-indent:0;margin:1em 0}div.illus img{max-width:100%;max-height:95vh}</style>` +
  `</head><body>${body}</body></html>`

/** 打开在线阅读（必须在点击等事件里调用：阅读器打开时会压一条返回键记录） */
export async function openOnlineInReader(meta: OnlineBookMeta, volumes?: SourceVolume[]) {
  const key = await ensureOnlineBook(meta, volumes)
  const ob = useOnline.getState().books[key]
  const st = useStore.getState()
  const hash = onlineHash(meta.source, meta.id)
  const now = Date.now()
  const rec: BookRecord = {
    hash,
    title: ob?.title || meta.title,
    author: ob?.author || meta.author || '',
    // 用 txt 的排版（纯段落，首行缩进）
    format: 'txt',
    fileName: `${meta.title}.online`,
    size: 0,
    addedAt: now,
    metaUpdatedAt: now,
    bookmarks: [],
    hasFile: true,
    hasCover: false,
    coverChecked: true,
    localOnly: true,
    online: { kind: meta.source, id: meta.id },
    updatedAt: now,
  }
  st.putOnlineRecord(rec)
  markOnlineOpened(key)
  st.openReader(hash)
}

/** 给阅读引擎的虚拟书（结构同 lib/txt.ts 的 makeTxtBook） */
export async function makeOnlineBook(rec: BookRecord) {
  const ref = rec.online!
  const src = sourceOf(ref.kind)
  const key = onlineKey(ref.kind, ref.id)
  let volumes = useOnline.getState().books[key]?.volumes
  if (!volumes?.length) {
    volumes = await src.getVolumes(ref.id)
    await ensureOnlineBook({ source: ref.kind, id: ref.id, title: rec.title, author: rec.author }, volumes)
  }
  const flat: { vol: SourceVolume; ch: SourceChapter; vi: number }[] = volumes.flatMap((vol, vi) => vol.chapters.map(ch => ({ vol, ch, vi })))
  if (!flat.length) throw new Error(tr('这本书还没有章节'))

  const urls = new Map<number, string>()
  const html = new Map<number, Promise<string>>()

  const build = (index: number): Promise<string> => {
    let p = html.get(index)
    if (!p) {
      p = (async () => {
        const { ch, vol } = flat[index]
        try {
          const c = await getOnlineChapter(src, ref.id, ch)
          // 插图：图片站有防盗链，先取回来转成本地地址
          const imgs = new Map<string, string>()
          await Promise.all(
            c.blocks
              .filter((b): b is Extract<ChapterBlock, { type: 'img' }> => b.type === 'img')
              .map(async b => imgs.set(b.src, await loadOnlineImage(b.src, src.referer).catch(() => ''))),
          )
          const first = index === 0 || flat[index - 1].vol !== vol
          const body =
            (first ? `<h1>${esc(vol.title)}</h1>` : '') +
            `<h2>${esc(ch.title || c.title)}</h2>` +
            c.blocks
              .map(b =>
                b.type === 'p' ? `<p>${esc(b.text)}</p>` : imgs.get(b.src) ? `<div class="illus"><img src="${imgs.get(b.src)}" alt=""/></div>` : '<p>[插图]</p>',
              )
              .join('')
          // 顺手把下一章抓好
          prefetchOnlineChapter(src, ref.id, flat[index + 1]?.ch)
          return page(ch.title, body)
        } catch (e) {
          html.delete(index)
          const msg = e instanceof Error ? e.message : String(e)
          return page(ch.title, `<h2>${esc(ch.title)}</h2><p>${esc(tr('这一章没能加载：{e}', { e: msg }))}</p><p>${esc(tr('翻到别的章节再回来会重新加载。'))}</p>`)
        }
      })()
      html.set(index, p)
    }
    return p
  }

  const sections = flat.map((_, index) => ({
    id: index,
    linear: 'yes',
    // 章节长度事先不知道：按一章约 1 万字估算（只影响进度百分比的精度）
    size: 30000,
    load: async () => {
      // 在线书架上显示“读到哪一章”
      const { vi, vol, ch } = flat[index]
      saveOnlineProgress(key, { vol: vi, ch: vol.chapters.indexOf(ch), ratio: 0, chapterId: ch.id })
      let url = urls.get(index)
      if (!url) {
        url = URL.createObjectURL(new Blob([await build(index)], { type: 'text/html;charset=utf-8' }))
        urls.set(index, url)
      }
      return url
    },
    unload: () => {
      const url = urls.get(index)
      if (url) URL.revokeObjectURL(url)
      urls.delete(index)
    },
    createDocument: async () => new DOMParser().parseFromString(await build(index), 'text/html'),
  }))

  // 目录：按卷分组
  let i = 0
  const toc = volumes.map(vol => {
    const start = i
    const subitems = vol.chapters.map(ch => ({ label: ch.title, href: String(i++) }))
    return { label: vol.title, href: String(start), subitems }
  })

  return {
    metadata: { title: rec.title, author: rec.author, language: 'zh' },
    dir: 'ltr',
    sections,
    toc,
    resolveHref: (href: string) => ({ index: Number(href.split('#')[0]) || 0, anchor: () => 0 }),
    splitTOCHref: (href: string) => [Number(href?.split('#')[0])],
    getTOCFragment: (doc: Document) => doc.body,
    isExternal: (uri: string) => /^\w+:/i.test(uri),
    getCover: () => null,
    destroy: () => {
      for (const url of urls.values()) URL.revokeObjectURL(url)
      urls.clear()
      html.clear()
    },
  }
}
