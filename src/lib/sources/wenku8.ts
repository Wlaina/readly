/**
 * 轻小说文库（wenku8）书源。
 * 页面结构参考 LightNovelReader 的 Wenku8WebsiteDataSource（Apache-2.0，© NightFish / yukonisen）。
 * 网站是 GBK 编码，交给隐藏浏览器打开，取回的 DOM 已经是正确的文字。
 * 读书不用登录；搜索要登录（用户在官方登录页里自己登录，Readly 不经手密码）。
 */
import { abs, loadPage, SEARCH_SLOT, text } from './browser'
import { encodeGbk } from './gbk'
import type { BookSource, ChapterBlock, ChapterContent, SearchHit, SearchOutcome, SourceChapter, SourceVolume } from './types'

const HOST = 'https://www.wenku8.net'
const titleRe = /^(.*?)\s*[(（](.*)[)）]\s*$/

const novelDir = (id: string) => `${HOST}/novel/${Math.floor(Number(id) / 1000)}/${id}`
const isLogin = (url: string) => /\/login\.php/.test(url)

function checkCopyright(doc: Document) {
  if ((doc.body.textContent ?? '').includes('因版权问题')) throw new Error('因版权问题，文库不再提供这本书')
}

/** 在网页里求值：章节标题与正文（文字段落、插图按顺序） */
const CHAPTER_EXTRACT = `(function(){
  var c = document.querySelector('#content'); if (!c) return null;
  var nbsp = new RegExp(String.fromCharCode(160), 'g'), out = [];
  function walk(p) {
    for (var n of p.childNodes) {
      if (n.nodeType === 3) { var t = n.textContent.replace(nbsp, ' ').trim(); if (t) out.push({ type: 'p', text: t }); }
      else if (n.nodeType === 1) {
        if (n.tagName === 'IMG') { var s = n.getAttribute('src'); if (s) out.push({ type: 'img', src: new URL(s, location.href).href }); }
        else if (n.matches('div.divimage, a')) walk(n);
      }
    }
  }
  walk(c);
  var t = document.querySelector('#title');
  return { title: t ? t.textContent : '', blocks: out, copyright: document.body.textContent.indexOf('因版权问题') >= 0 };
})()`

/**
 * 文库提供整本 TXT 下载（dl.wenku8.com，不经过 Cloudflare、不受网页访问频率限制）：
 * 一次请求拿到全书，每章开头是一行没有缩进的“卷名 章名”，正文每段缩进。
 * 按书号缓存在内存里，下载、在线阅读都用它，翻到哪章都是秒开。
 */
const bookText = new Map<string, Promise<Map<string, string[]>>>()

function fetchBookText(bookId: string): Promise<Map<string, string[]>> {
  let p = bookText.get(bookId)
  if (!p) {
    p = (async () => {
      const { fetch } = await import('@tauri-apps/plugin-http')
      const res = await fetch(`https://dl.wenku8.com/down.php?type=utf8&node=1&id=${bookId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const txt = new TextDecoder('utf-8').decode(await res.arrayBuffer())
      if (!txt.includes('WenKu8')) throw new Error('不是文库的文本')
      // 按“没有缩进的一行”切开，键是那一行（卷名 章名）
      const map = new Map<string, string[]>()
      let cur: string[] | null = null
      for (const raw of txt.split(/\r?\n/)) {
        if (!raw.trim()) continue
        if (!/^[\s\u3000]/.test(raw)) {
          cur = []
          map.set(norm(raw), cur)
          continue
        }
        cur?.push(raw.replace(/\u00a0/g, ' ').trim())
      }
      return map
    })()
    p.catch(() => bookText.delete(bookId))
    bookText.set(bookId, p)
  }
  return p
}

const norm = (s: string) => s.replace(/[\s\u3000]+/g, ' ').trim()

async function chapterFromText(bookId: string, ch: SourceChapter): Promise<ChapterContent | null> {
  if (!ch.volume) return null
  const map = await fetchBookText(bookId)
  const lines = map.get(norm(`${ch.volume} ${ch.title}`))
  if (!lines?.length) return null
  const blocks: ChapterBlock[] = lines.filter(l => !/轻小说文库|wenku8/i.test(l)).map(t => ({ type: 'p', text: t }))
  return { title: ch.title, blocks }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 搜索结果页里的书（每本书是一张卡片：封面链接 + 作者、简介） */
function parseHits(doc: Document): SearchHit[] {
  const hits = new Map<string, SearchHit>()
  for (const a of doc.querySelectorAll<HTMLAnchorElement>('#content a[href*="/book/"]')) {
    const id = a.getAttribute('href')?.match(/\/book\/(\d+)\.htm/)?.[1]
    if (!id || hits.has(id)) continue
    const card = a.closest('td > div') ?? a.parentElement?.parentElement
    // 书名在 tiptitle 属性里；第一个链接是封面图，没有文字
    const named = card?.querySelector('b a') ?? a
    const raw = named.getAttribute('tiptitle') || named.getAttribute('title') || text(named) || a.getAttribute('tiptitle') || ''
    const m = raw.match(titleRe)
    const lines = [...(card?.querySelectorAll('p') ?? [])].map(p => text(p))
    hits.set(id, {
      source: 'wenku8',
      id,
      title: m ? m[1] : raw,
      author:
        lines
          .find(l => l.startsWith('作者'))
          ?.split('/')[0]
          .replace(/^作者[:：]/, '')
          .trim() ?? '',
      cover: abs(doc, card?.querySelector('img')?.getAttribute('src')),
      intro:
        lines
          .find(l => l.startsWith('简介'))
          ?.replace(/^简介[:：]/, '')
          .trim() ?? '',
    })
  }
  return [...hits.values()].filter(h => h.title)
}

async function searchBy(type: 'articlename' | 'author', keyword: string, signal?: AbortSignal): Promise<SearchOutcome> {
  const url = `${HOST}/modules/article/search.php?searchtype=${type}&searchkey=${encodeGbk(keyword)}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const { url: final, doc } = await loadPage(url, {
      selector: 'body',
      signal,
      desktop: true,
      slot: SEARCH_SLOT,
    })
    // 没登录时会跳到登录页（有时直接显示登录表单）
    if (isLogin(final) || doc.querySelector('input[name=password]')) return { needLogin: true }
    // 网站限制两次搜索至少间隔 5 秒
    if ((doc.body.textContent ?? '').includes('间隔时间不得少于')) {
      await sleep(5500)
      continue
    }
    // 只有一个结果时直接跳到书页
    const direct = final.match(/\/book\/(\d+)\.htm/)?.[1]
    // 既不是登录页、也不是搜索结果页（例如被网站换成了别的提示页）：多半是没登录，让用户打开网页看看
    if (!direct && !doc.querySelector('#content')) return { needLogin: true }
    if (direct) {
      const b = await wenku8.getBook(direct)
      return {
        hits: [
          {
            source: 'wenku8',
            id: direct,
            title: b.title,
            author: b.author,
            cover: b.cover,
            intro: b.description,
          },
        ],
      }
    }
    return { hits: parseHits(doc) }
  }
  throw new Error('搜索太频繁，请稍后再试')
}

export const wenku8: BookSource = {
  id: 'wenku8',
  name: '轻小说文库',
  home: HOST,
  loginUrl: `${HOST}/login.php`,
  referer: `${HOST}/`,

  parseId(input) {
    const s = input.trim()
    if (/^\d{1,6}$/.test(s)) return s
    if (!/wenku8\./.test(s)) return null
    return s.match(/\/book\/(\d+)\.htm/)?.[1] ?? s.match(/\/novel\/\d+\/(\d+)\//)?.[1] ?? s.match(/aid=(\d+)/)?.[1] ?? null
  },

  async search(keyword, signal) {
    const byName = await searchBy('articlename', keyword, signal)
    if (!('hits' in byName) || byName.hits.length) return byName
    // 书名找不到时按作者再找一次
    await sleep(5500)
    return searchBy('author', keyword, signal)
  },

  async getBook(id) {
    const { doc } = await loadPage(`${HOST}/book/${id}.htm`, {
      selector: '#content',
      desktop: true,
    })
    checkCopyright(doc)
    const tables = doc.querySelectorAll('#content > div > table')
    const rawTitle = text(tables[0]?.querySelector('span b'))
    if (!rawTitle) throw new Error('找不到这本书')
    const m = rawTitle.match(titleRe)
    const cells = [...(tables[0]?.querySelectorAll('tr:nth-of-type(2) > td') ?? [])].map(td => text(td))
    const field = (label: string) =>
      cells
        .find(c => c.startsWith(label))
        ?.slice(label.length)
        .trim() ?? ''
    const spans = [...(tables[1]?.querySelectorAll('td:nth-of-type(2) > span') ?? [])]
    const tagSpan = spans.find(s => text(s).includes('作品Tags'))
    // 简介：最后一个较长的 span
    const desc =
      spans
        .filter(s => s !== tagSpan)
        .map(s => (s.textContent ?? '').trim())
        .filter(s => s.length > 20)
        .pop() ?? ''
    return {
      source: 'wenku8',
      id,
      title: m ? m[1] : rawTitle,
      author: field('小说作者：'),
      cover: abs(doc, tables[1]?.querySelector('img')?.getAttribute('src')),
      description: desc,
      tags: text(tagSpan)
        .replace(/.*作品Tags：/, '')
        .split(/\s+/)
        .filter(Boolean),
      status: field('文章状态：'),
      updated: field('最后更新：'),
    }
  },

  async getVolumes(id) {
    const { doc } = await loadPage(`${novelDir(id)}/index.htm`, {
      selector: 'table',
      desktop: true,
    })
    checkCopyright(doc)
    const vols: SourceVolume[] = []
    let cur: SourceVolume | null = null
    for (const tr of doc.querySelectorAll('table tr')) {
      const vcss = tr.querySelector('td.vcss')
      if (vcss) {
        cur = {
          id: vcss.getAttribute('vid') ?? String(vols.length),
          title: text(vcss),
          chapters: [],
        }
        vols.push(cur)
        continue
      }
      for (const a of tr.querySelectorAll('td > a')) {
        const href = a.getAttribute('href') ?? ''
        const cid = href.split('.')[0]
        if (!cid || !cur) continue
        cur.chapters.push({ id: cid, title: text(a), url: abs(doc, href), volume: cur.title })
      }
    }
    if (!vols.length) throw new Error('目录为空')
    return vols
  },

  async getChapter(bookId, ch: SourceChapter, o = {}) {
    // 优先用整本文本（一次下载、按章切开，秒出；插图章节要看图，仍打开网页）
    if (!/插图|插畫/.test(ch.title)) {
      const fromText = await chapterFromText(bookId, ch).catch(e => {
        console.warn('文库整本文本不可用，改为逐章打开网页', e)
        return null
      })
      if (fromText) return fromText
    }
    // 在网页里直接取出正文（不把整页 HTML 传回来再解析，下载时主界面不卡）
    const { data } = await loadPage(ch.url || `${novelDir(bookId)}/${ch.id}.htm`, {
      selector: '#content',
      desktop: true,
      noHtml: true,
      extract: CHAPTER_EXTRACT,
      ...o,
    })
    const r = data as {
      title: string
      blocks: ChapterBlock[]
      copyright: boolean
    } | null
    if (!r) throw new Error('找不到正文')
    if (r.copyright) throw new Error('因版权问题，文库不再提供这本书')
    const blocks = r.blocks.filter(b => (b.type === 'img' ? b.src : b.text))
    // 文库在正文末尾附的网站声明不要
    while (blocks.length && blocks[blocks.length - 1].type === 'p' && /轻小说文库|wenku8/i.test((blocks[blocks.length - 1] as { text: string }).text))
      blocks.pop()
    return { title: r.title.trim() || ch.title, blocks }
  },
}
