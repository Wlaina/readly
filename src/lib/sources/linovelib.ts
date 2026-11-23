/**
 * 哔哩轻小说（linovelib）书源，电脑版网页（安卓上也用电脑版浏览器标识打开，否则会被跳到结构不同的手机版）。
 * 段落顺序还原参考 LightNovelReaderPlugin-linovelib 的 LinovelibParagraphOrder（Apache-2.0）。
 * 章节会分成多页（xxx.html、xxx_2.html …），按“下一页”一直读到换章为止。
 * 搜索在姊妹站 bilinovel 上，要先输入图片验证码（通过后 30 分钟内免验证）。
 */
import { abs, loadPage, text, type LoadedPage } from './browser'
import type { BookSource, ChapterBlock, FetchOptions, SearchHit, SearchOutcome, SourceChapter, SourceVolume } from './types'

const HOST = 'https://www.linovelib.com'
/** 同一个书库、同样的书号；linovelib 自己的搜索会把自动访问导走 */
const SEARCH = 'https://www.bilinovel.com/search.html'

/** 网站把第 20 段之后的段落按章节号打乱，网页脚本再排回来；这里是同一个还原算法（备用） */
export function restoreParagraphs<T>(chapterId: string, shuffled: T[]): T[] {
  const FIXED = 20
  if (shuffled.length <= FIXED) return shuffled
  const n = Number(chapterId)
  if (!Number.isFinite(n)) return shuffled
  const perm = shuffled.map((_, i) => i)
  let seed = n * 126 + 232
  for (let i = shuffled.length - 1; i >= FIXED + 1; i--) {
    seed = (seed * 9302 + 49397) % 233280
    const j = FIXED + Math.floor((seed / 233280) * (i - FIXED + 1))
    ;[perm[i], perm[j]] = [perm[j], perm[i]]
  }
  const out = shuffled.slice()
  shuffled.forEach((v, raw) => (out[perm[raw]] = v))
  return out
}

/** 在网页里求值：正文里真正显示出来的段落和插图，按屏幕上的位置排序 */
const VISIBLE_BLOCKS = `[...document.querySelectorAll('#TextContent > p, #TextContent img')]
  .map(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { e, top: r.top, ok: (e.tagName === 'IMG' || r.height > 0) && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' } })
  .filter(x => x.ok)
  .sort((a, b) => a.top - b.top)
  .map(x => x.e.tagName === 'IMG' ? { type: 'img', src: new URL(x.e.getAttribute('data-src') || x.e.getAttribute('src') || '', location.href).href } : { type: 'p', text: x.e.innerText.trim() })`

/** 在网页里求值：一页正文（真正显示的段落与插图）、标题、下一页地址（手机版写在 ReadParams.url_next，电脑版是“下一页”链接） */
const PAGE_EXTRACT = `(function(){
  var blocks = ${VISIBLE_BLOCKS};
  var h = document.querySelector('#mlfy_main_text h1, h1');
  var m = document.documentElement.innerHTML.match(/url_next[ ]*:[ ]*['"]([^'"]*)['"]/);
  var next = m ? m[1] : '';
  if (!next) { var a = Array.prototype.find.call(document.querySelectorAll('a'), function (x) { var t = x.textContent.trim(); return t === '下一页' || t === '下一章'; }); next = a ? a.getAttribute('href') : ''; }
  return { title: h ? h.textContent : '', blocks: blocks, next: next ? new URL(next, location.href).href : '' };
})()`

/** 验证码图片：在网页里画到画布上转成 data URL（同源图片，不会被拦） */
const CAPTCHA_IMAGE = `(function(){ var i = document.querySelector('img[src*="checkcode"]'); if (!i || !i.naturalWidth) return null; var c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; c.getContext('2d').drawImage(i, 0, 0); return c.toDataURL('image/png') })()`

const bookIdOf = (href: string | null | undefined) => href?.match(/\/novel\/(\d+)\.html/)?.[1]

/** 搜索结果页：结果列表（.book-ol .book-li）里的书；页面上的推荐、热门不算 */
function parseHits(doc: Document): SearchHit[] {
  const hits = new Map<string, SearchHit>()
  const links = doc.querySelectorAll('.book-ol .book-li a[href*="/novel/"], .search-result a[href*="/novel/"]')
  for (const a of links) {
    const id = bookIdOf(a.getAttribute('href'))
    if (!id) continue
    const card = a.closest('li, .book-li, .search-result, .book-layout') ?? a
    const img = card.querySelector('img')
    const prev = hits.get(id)
    const title = text(card.querySelector('.book-title, h3, h4, .tit')) || img?.getAttribute('alt')?.trim() || text(a)
    hits.set(id, {
      source: 'linovelib',
      id,
      title: prev?.title || title,
      author: prev?.author || text(card.querySelector('.book-author, .author, .au-name')).replace(/^\s*作者[:：]?\s*/, ''),
      cover: prev?.cover || abs(doc, img?.getAttribute('data-src') || img?.getAttribute('data-original') || img?.getAttribute('src')),
      intro: prev?.intro || text(card.querySelector('.book-desc, .book-dec, .intro')),
    })
  }
  return [...hits.values()].filter(h => h.title && !/^\d+$/.test(h.title))
}

async function searchResult(page: LoadedPage): Promise<SearchOutcome> {
  if (page.doc.querySelector('input[name=search_challenge]')) {
    if (typeof page.data !== 'string') throw new Error('验证码图片没有加载出来，请重试')
    return { captcha: page.data }
  }
  // 只有一个结果时会直接跳到书页
  const direct = bookIdOf(page.url)
  if (direct) {
    const b = await linovelib.getBook(direct)
    return {
      hits: [
        {
          source: 'linovelib',
          id: direct,
          title: b.title,
          author: b.author,
          cover: b.cover,
          intro: b.description,
        },
      ],
    }
  }
  return { hits: parseHits(page.doc) }
}

/** 链接坏掉的章节：一页页翻完上一章，最后一页的“下一章”就是本章的地址（结果记住，不重复找） */
const resolvedUrls = new Map<SourceChapter, Promise<string>>()
function resolveUrl(ch: SourceChapter, o: FetchOptions): Promise<string> {
  if (ch.url) return Promise.resolve(ch.url)
  let p = resolvedUrls.get(ch)
  if (!p) {
    p = (async () => {
      const prev = ch.prev?.ref
      if (!prev) throw new Error('章节链接失效，而且找不到上一章')
      let url = prev.url || (await resolveUrl(prev, o))
      const prevId = url.match(/\/(\d+)\.html/)?.[1] ?? ''
      for (let i = 0; i < 30 && url; i++) {
        const { data } = await loadPage(url, {
          selector: '#TextContent',
          extract: PAGE_EXTRACT,
          desktop: true,
          noHtml: true,
          waitAll: true,
          ...o,
        })
        const next = (data as { next?: string } | null)?.next ?? ''
        if (next && new RegExp(`/${prevId}_[0-9]+[.]html`).test(next)) {
          url = next
          continue
        }
        if (!/\/novel\/\d+\/\d+\.html/.test(next)) break
        return next
      }
      throw new Error('找不到这一章的地址（网站把链接隐藏了）')
    })()
    p.catch(() => resolvedUrls.delete(ch))
    resolvedUrls.set(ch, p)
  }
  return p
}

export const linovelib: BookSource = {
  id: 'linovelib',
  name: '哔哩轻小说',
  home: HOST,
  loginUrl: `${HOST}/login.php`,
  referer: `${HOST}/`,

  parseId(input) {
    const s = input.trim()
    if (/^\d{1,6}$/.test(s)) return s
    if (!/linovelib\.|bilinovel\./.test(s)) return null
    return s.match(/\/novel\/(\d+)/)?.[1] ?? null
  },

  async search(keyword, signal) {
    const page = await loadPage(`${SEARCH}?searchkey=${encodeURIComponent(keyword)}`, {
      selector: 'body',
      extract: CAPTCHA_IMAGE,
      desktop: true,
      images: true,
      waitAll: true,
      signal,
    })
    return searchResult(page)
  },

  async submitCaptcha(code, signal) {
    const safe = JSON.stringify(code.trim())
    const page = await loadPage(SEARCH, {
      selector: 'body',
      extract: CAPTCHA_IMAGE,
      desktop: true,
      images: true,
      waitAll: true,
      signal,
      action: `var i = document.querySelector('#search_code, input[name=search_code]'); if (i) { i.value = ${safe}; (i.form || document.forms[0]).submit(); }`,
    })
    return searchResult(page)
  },

  async getBook(id) {
    const { doc } = await loadPage(`${HOST}/novel/${id}.html`, {
      selector: '.book-info',
      desktop: true,
    })
    const info = doc.querySelector('.book-info')
    const nums = [...(info?.querySelectorAll('.nums span') ?? [])].map(s => text(s))
    return {
      source: 'linovelib',
      id,
      title: text(info?.querySelector('.book-name')),
      author: text(doc.querySelector('.au-name a')),
      cover: abs(doc, doc.querySelector('.book-img img, .book-cover img')?.getAttribute('src')),
      description: (info?.querySelector('.book-dec p')?.textContent ?? '').trim(),
      tags: [...(info?.querySelectorAll('.book-label span a') ?? [])].map(a => text(a)),
      status: text(info?.querySelector('.book-label .state')),
      updated: nums.find(s => s.includes('更新'))?.replace(/.*[:：]/, '') ?? '',
    }
  },

  async getVolumes(id) {
    const { doc } = await loadPage(`${HOST}/novel/${id}/catalog`, {
      selector: '.volume-list, .chapter-list',
      desktop: true,
    })
    let prev: SourceChapter | undefined
    const vols: SourceVolume[] = [...doc.querySelectorAll('.volume')].map((v, i) => ({
      id:
        v
          .querySelector('.v-line a')
          ?.getAttribute('href')
          ?.match(/vol_(\d+)/)?.[1] ?? String(i),
      title: text(v.querySelector('.v-line')),
      // 目录页上每卷都有大封面（书页上的只是小缩略图）
      cover: abs(doc, v.querySelector('.volume-cover img')?.getAttribute('data-original') || v.querySelector('.volume-cover img')?.getAttribute('src')) || undefined,
      chapters: [...v.querySelectorAll('.chapter-list a[href]')].map(a => {
        const href = a.getAttribute('href') ?? ''
        const cid = href.match(/\/(\d+)\.html/)?.[1]
        // 网站会故意把个别章节的链接写成 javascript:cid(0)：记下上一章，下载时从上一章末尾的“下一章”找回
        const ch: SourceChapter = cid
          ? { id: cid, title: text(a), url: abs(doc, href) }
          : {
              id: `broken-${i}-${text(a)}`,
              title: text(a),
              url: '',
              prev: prev && { url: prev.url, id: prev.id, ref: prev },
            }
        prev = ch
        return ch
      }),
    }))
    if (!vols.length) throw new Error('目录为空')
    return vols
  },

  async getChapter(_bookId, ch, o = {}) {
    const blocks: ChapterBlock[] = []
    let url = ch.url || (await resolveUrl(ch, o))
    const cid = url.match(/\/(\d+)\.html/)?.[1] ?? ch.id
    let title = ''
    for (let page = 1; page <= 30 && url; page++) {
      // 在网页里直接取出正文和下一页地址（不把整页 HTML 传回来再解析，下载时主界面不卡）
      const { data } = await loadPage(url, {
        selector: '#TextContent',
        extract: PAGE_EXTRACT,
        desktop: true,
        noHtml: true,
        waitAll: true,
        ...o,
      })
      const r = data as {
        title: string
        blocks: ChapterBlock[]
        next: string
      } | null
      if (!r || !Array.isArray(r.blocks)) throw new Error('找不到正文')
      title ||= r.title.trim()
      for (const b of r.blocks) if (b.type === 'img' ? b.src : b.text) blocks.push(b)
      // 下一页还是本章（xxx_2.html）就继续，换章就停
      url = r.next && new RegExp(`/${cid}_[0-9]+[.]html`).test(r.next) ? r.next : ''
    }
    return { title: title || ch.title, blocks }
  },
}
