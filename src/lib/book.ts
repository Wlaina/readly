import { EPUB } from '../vendor/foliate-js/epub.js'
import { configure, ZipReader, BlobReader, TextWriter, BlobWriter } from '../vendor/foliate-js/vendor/zip.js'
import { makeTxtBook } from './txt'
import { repairXML } from './xmlfix'
import type { BookRecord, Format } from './types'
import { tr } from './i18n'

configure({ useWebWorkers: false })

async function makeEpub(blob: Blob) {
  const reader = new ZipReader(new BlobReader(blob))
  const entries: any[] = await reader.getEntries()
  const map = new Map(entries.map(e => [e.filename, e]))
  const load =
    (f: (entry: any, ...args: any[]) => any) =>
    (name: string, ...args: any[]) =>
      map.has(name) ? f(map.get(name), ...args) : null
  const loader = {
    entries,
    // 读文本时顺手修复常见的 XML 毛病（错位的斜杠、缺斜杠的命名空间、未转义的 & 等）
    loadText: load(async e => repairXML(e.filename, await e.getData(new TextWriter()))),
    loadBlob: load((e, type) => e.getData(new BlobWriter(type))),
    getSize: (name: string) => map.get(name)?.uncompressedSize ?? 0,
  }
  return await new EPUB(loader).init()
}

export function detectFormat(fileName: string): Format | null {
  const n = fileName.toLowerCase()
  if (n.endsWith('.epub')) return 'epub'
  if (n.endsWith('.txt')) return 'txt'
  return null
}

const stripExt = (name: string) => name.replace(/\.[^.]+$/, '')

/** 打开书籍，返回 foliate-js 的 book 对象 */
export async function openBook(format: Format, bytes: Uint8Array, fileName: string): Promise<any> {
  if (format === 'epub') return makeEpub(new Blob([bytes as BlobPart], { type: 'application/epub+zip' }))
  return makeTxtBook(bytes, stripExt(fileName))
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')
}

const formatLangMap = (x: any): string => {
  if (!x) return ''
  if (typeof x === 'string') return x
  const keys = Object.keys(x)
  return x[keys[0]] ?? ''
}
const formatContributor = (c: any): string =>
  Array.isArray(c) ? c.map(formatContributor).filter(Boolean).join('、') : typeof c === 'string' ? c : formatLangMap(c?.name)

export async function parseImport(file: File) {
  const format = detectFormat(file.name)
  if (!format) throw new Error(tr('不支持的格式：{name}', { name: file.name }))
  const bytes = new Uint8Array(await file.arrayBuffer())
  const hash = await hashBytes(bytes)
  let title = stripExt(file.name)
  let author = ''
  let cover: Blob | null = null
  if (format === 'epub') {
    const book = await openBook(format, bytes, file.name)
    title = formatLangMap(book.metadata?.title) || title
    author = formatContributor(book.metadata?.author)
    cover = await Promise.resolve(book.getCover?.()).catch(() => null)
    book.destroy?.()
  }
  const now = Date.now()
  const rec: BookRecord = {
    hash,
    title,
    author,
    format,
    fileName: file.name,
    size: bytes.byteLength,
    addedAt: now,
    metaUpdatedAt: now,
    bookmarks: [],
    hasFile: true,
    hasCover: !!cover,
    updatedAt: now,
  }
  return { rec, bytes, cover }
}
