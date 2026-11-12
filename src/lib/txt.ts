/**
 * 把 TXT 转换成 foliate-js 可直接渲染的 book 对象：
 * 自动识别编码（UTF-8 / UTF-16 / GB18030）与章节标题，按章节懒生成 HTML。
 */

export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030').decode(bytes)
  }
}

const CN_NUM = '0-9０-９零〇一二两三四五六七八九十百千万'
const CHAPTER_RE = new RegExp(
  [
    `^第[${CN_NUM}]+[章节回卷集部篇幕话](?:[\\s:：、.·\\-—]|$).{0,40}$`,
    `^第[${CN_NUM}]+[章节回卷集部篇幕话]$`,
    `^(?:序章|序言|序|楔子|引子|引言|前言|后记|尾声|终章|番外|简介|内容简介|作品相关)(?:[\\s:：、.·\\-—].{0,30})?$`,
    `^(?:chapter|CHAPTER|Chapter)\\s+[0-9IVXLCivxlc]+\\b.{0,40}$`,
  ].join('|'),
)

interface Chapter {
  title: string
  start: number // 行号（含标题行）
  end: number
}

const MAX_SECTION_CHARS = 60000
const FALLBACK_CHARS = 12000

function splitChapters(lines: string[]): Chapter[] {
  const heads: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.length > 0 && t.length <= 48 && CHAPTER_RE.test(t)) heads.push(i)
  }
  const chapters: Chapter[] = []
  if (heads.length >= 2) {
    if (heads[0] > 0 && lines.slice(0, heads[0]).some(l => l.trim()))
      chapters.push({ title: '前言', start: 0, end: heads[0] })
    heads.forEach((h, i) =>
      chapters.push({ title: lines[h].trim(), start: h, end: heads[i + 1] ?? lines.length }),
    )
  } else {
    chapters.push({ title: '', start: 0, end: lines.length })
  }
  // 超长章节或未识别到章节时，按字数切分，避免单个 iframe 过大
  const out: Chapter[] = []
  for (const ch of chapters) {
    let chars = 0
    let segStart = ch.start
    let part = 1
    const limit = heads.length >= 2 ? MAX_SECTION_CHARS : FALLBACK_CHARS
    for (let i = ch.start; i < ch.end; i++) {
      chars += lines[i].length
      if (chars >= limit && i < ch.end - 1) {
        out.push({ title: ch.title ? `${ch.title}（${part}）` : `第 ${out.length + 1} 部分`, start: segStart, end: i + 1 })
        segStart = i + 1
        chars = 0
        part++
      }
    }
    const title = ch.title ? (part > 1 ? `${ch.title}（${part}）` : ch.title) : `第 ${out.length + 1} 部分`
    out.push({ title, start: segStart, end: ch.end })
  }
  return out
}

const escapeHTML = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function makeTxtBook(bytes: Uint8Array, title: string) {
  const text = decodeText(bytes).replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const chapters = splitChapters(lines)
  const urls = new Map<number, string>()

  const buildHTML = (ch: Chapter, index: number) => {
    let body = ''
    let i = ch.start
    const first = lines[i]?.trim()
    if (first && CHAPTER_RE.test(first) && first.length <= 48) {
      body += `<h2>${escapeHTML(first)}</h2>`
      i++
    } else if (index === 0 && !ch.title.startsWith('第')) {
      body += `<h1>${escapeHTML(title)}</h1>`
    }
    for (; i < ch.end; i++) {
      const t = lines[i].trim()
      if (t) body += `<p>${escapeHTML(t)}</p>`
    }
    return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHTML(
      ch.title,
    )}</title><style>h1,h2{text-align:center;text-indent:0;margin:1.2em 0 1em}</style></head><body>${body}</body></html>`
  }

  const sections = chapters.map((ch, index) => ({
    id: index,
    linear: 'yes',
    size: lines.slice(ch.start, ch.end).reduce((a, l) => a + l.length * 3, 0) + 200,
    load: () => {
      let url = urls.get(index)
      if (!url) {
        url = URL.createObjectURL(new Blob([buildHTML(ch, index)], { type: 'text/html;charset=utf-8' }))
        urls.set(index, url)
      }
      return url
    },
    unload: () => {
      const url = urls.get(index)
      if (url) URL.revokeObjectURL(url)
      urls.delete(index)
    },
    createDocument: () => new DOMParser().parseFromString(buildHTML(ch, index), 'text/html'),
    // 新版引擎用它拆分超大章节，并在后台预加载相邻章节
    loadContent: () => buildHTML(ch, index),
  }))

  return {
    metadata: { title, author: '', language: 'zh' },
    dir: 'ltr',
    sections,
    toc: chapters.map((ch, i) => ({ label: ch.title, href: String(i) })),
    resolveHref: (href: string) => ({ index: Number(href.split('#')[0]) || 0, anchor: () => 0 }),
    splitTOCHref: (href: string) => [Number(href?.split('#')[0])],
    getTOCFragment: (doc: Document) => doc.body,
    isExternal: (uri: string) => /^\w+:/i.test(uri),
    getCover: () => null,
    destroy: () => {
      for (const url of urls.values()) URL.revokeObjectURL(url)
      urls.clear()
    },
  }
}
