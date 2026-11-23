/**
 * 修改 EPUB 文件里的书名、作者：改写 OPF 中的 dc:title / dc:creator 后重新打包。
 * mimetype 必须是第一个文件且不压缩，这是 EPUB 规范要求。
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { repairXML } from './xmlfix'
import { tr } from './i18n'

const DC = 'http://purl.org/dc/elements/1.1/'
const STORED = /\.(jpe?g|png|gif|webp|mp3|mp4|m4a|woff2?|zip)$/i

export interface EpubMeta {
  title?: string
  author?: string
}

export function setEpubMetadata(bytes: Uint8Array, meta: EpubMeta): Uint8Array {
  const files = unzipSync(bytes)
  const container = files['META-INF/container.xml']
  if (!container) throw new Error(tr('不是有效的 EPUB（缺少 container.xml）'))
  const opfPath = strFromU8(container).match(/full-path\s*=\s*["']([^"']+)["']/)?.[1]
  if (!opfPath || !files[opfPath]) throw new Error(tr('找不到书籍信息文件（OPF）'))

  const opfText = repairXML(opfPath, strFromU8(files[opfPath]))
  const doc = new DOMParser().parseFromString(opfText, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error(tr('书籍信息文件格式有误，无法修改'))
  const metadata = doc.getElementsByTagNameNS('*', 'metadata')[0]
  if (!metadata) throw new Error(tr('书籍信息文件里没有 metadata'))

  const setDc = (name: string, value?: string) => {
    if (value === undefined) return
    const els = Array.from(metadata.getElementsByTagNameNS(DC, name))
    if (els.length) {
      els[0].textContent = value
      // 多个作者时，保留第一个并改成新值，其余删掉（书架上编辑的是完整作者字符串）
      if (name === 'creator') for (const el of els.slice(1)) el.remove()
    } else {
      const prefix = metadata.lookupPrefix(DC) ?? doc.documentElement.lookupPrefix(DC) ?? 'dc'
      if (!metadata.lookupNamespaceURI(prefix)) metadata.setAttribute(`xmlns:${prefix}`, DC)
      const el = doc.createElementNS(DC, `${prefix}:${name}`)
      el.textContent = value
      metadata.appendChild(el)
    }
  }
  setDc('title', meta.title)
  setDc('creator', meta.author)

  let out = new XMLSerializer().serializeToString(doc)
  if (!out.startsWith('<?xml')) out = `<?xml version="1.0" encoding="utf-8"?>\n${out}`
  files[opfPath] = strToU8(out)

  // 重新打包：mimetype 放第一个且不压缩；图片等已压缩的格式直接存储，省时间
  const zip: Zippable = {}
  if (files['mimetype']) zip['mimetype'] = [files['mimetype'], { level: 0 }]
  for (const [name, data] of Object.entries(files)) {
    if (name === 'mimetype' || name.endsWith('/')) continue
    zip[name] = [data, { level: STORED.test(name) ? 0 : 6 }]
  }
  return zipSync(zip)
}

/* ---------- 封面 ---------- */

/** 换封面前的原样（存在书籍文件里，哪台设备都能恢复） */
interface CoverBackup {
  /** 封面图在 OPF 里的地址 */
  href: string
  mediaType: string
  /** 原封面图备份在压缩包里的路径；added 时没有 */
  backup?: string
  /** 原来没有封面，是我们加的 */
  added?: boolean
}

const BACKUP_JSON = 'readly-cover.json'
const BACKUP_IMG = 'readly-cover-original'
const OPF_NS = 'http://www.idpf.org/2007/opf'

function openOpf(bytes: Uint8Array) {
  const files = unzipSync(bytes)
  const container = files['META-INF/container.xml']
  if (!container) throw new Error(tr('不是有效的 EPUB（缺少 container.xml）'))
  const opfPath = strFromU8(container).match(/full-path\s*=\s*["']([^"']+)["']/)?.[1]
  if (!opfPath || !files[opfPath]) throw new Error(tr('找不到书籍信息文件（OPF）'))
  const doc = new DOMParser().parseFromString(repairXML(opfPath, strFromU8(files[opfPath])), 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error(tr('书籍信息文件格式有误，无法修改'))
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  /** OPF 里的相对地址 → 压缩包里的路径 */
  const resolve = (href: string) => decodeURIComponent(new URL(href, `http://x/${dir}`).pathname.slice(1))
  const items = Array.from(doc.getElementsByTagNameNS('*', 'item'))
  return { files, opfPath, dir, doc, resolve, items }
}

function coverItem(doc: Document, items: Element[]): Element | null {
  const byProp = items.find(i => (i.getAttribute('properties') ?? '').split(/\s+/).includes('cover-image'))
  if (byProp) return byProp
  const metaId = Array.from(doc.getElementsByTagNameNS('*', 'meta')).find(m => m.getAttribute('name') === 'cover')?.getAttribute('content')
  const byMeta = metaId ? items.find(i => i.getAttribute('id') === metaId) : undefined
  if (byMeta) return byMeta
  return items.find(i => /^image\//.test(i.getAttribute('media-type') ?? '') && /cover/i.test(`${i.getAttribute('id')} ${i.getAttribute('href')}`)) ?? null
}

function saveOpf(o: ReturnType<typeof openOpf>) {
  let out = new XMLSerializer().serializeToString(o.doc)
  if (!out.startsWith('<?xml')) out = `<?xml version="1.0" encoding="utf-8"?>\n${out}`
  o.files[o.opfPath] = strToU8(out)
  return repack(o.files)
}

function repack(files: Record<string, Uint8Array>): Uint8Array {
  const zip: Zippable = {}
  if (files['mimetype']) zip['mimetype'] = [files['mimetype'], { level: 0 }]
  for (const [name, data] of Object.entries(files)) {
    if (name === 'mimetype' || name.endsWith('/')) continue
    zip[name] = [data, { level: STORED.test(name) || name.endsWith(BACKUP_IMG) ? 0 : 6 }]
  }
  return zipSync(zip)
}

/** 书里的图片（按目录文件里的顺序），换封面时可以从中挑 */
export function epubImages(bytes: Uint8Array): { path: string; type: string; bytes: Uint8Array; isCover: boolean }[] {
  const o = openOpf(bytes)
  const cover = coverItem(o.doc, o.items)
  return o.items
    .filter(i => /^image\/(jpeg|png|gif|webp)/.test(i.getAttribute('media-type') ?? ''))
    .map(i => {
      const path = o.resolve(i.getAttribute('href') ?? '')
      return { path, type: i.getAttribute('media-type')!, bytes: o.files[path], isCover: i === cover }
    })
    .filter(i => i.bytes?.length)
}

/** 封面是不是换过（能不能恢复） */
export function hasCustomCover(bytes: Uint8Array): boolean {
  return Object.keys(unzipSync(bytes, { filter: f => f.name.endsWith(BACKUP_JSON) })).length > 0
}

/**
 * 换封面：新图片写到原封面图的位置（封面页上显示的也一起换掉），第一次换时把原图备份在文件里。
 * 原来没有封面的书，新加一张并标成封面
 */
export function setEpubCover(bytes: Uint8Array, img: { bytes: Uint8Array; type: string }): Uint8Array {
  const o = openOpf(bytes)
  const jsonPath = o.dir + BACKUP_JSON
  const hadBackup = !!o.files[jsonPath]
  const item = coverItem(o.doc, o.items)
  if (item) {
    const path = o.resolve(item.getAttribute('href') ?? '')
    if (!hadBackup) {
      const backup: CoverBackup = { href: item.getAttribute('href') ?? '', mediaType: item.getAttribute('media-type') ?? '' }
      if (o.files[path]) {
        o.files[o.dir + BACKUP_IMG] = o.files[path]
        backup.backup = BACKUP_IMG
      }
      o.files[jsonPath] = strToU8(JSON.stringify(backup))
    }
    o.files[path] = img.bytes
    item.setAttribute('media-type', img.type)
  } else {
    const ext = img.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg'
    const href = `readly-cover.${ext}`
    const manifest = o.doc.getElementsByTagNameNS('*', 'manifest')[0]
    const metadata = o.doc.getElementsByTagNameNS('*', 'metadata')[0]
    if (!manifest || !metadata) throw new Error(tr('书籍信息文件里没有 manifest'))
    const ns = manifest.namespaceURI || OPF_NS
    const el = o.doc.createElementNS(ns, 'item')
    el.setAttribute('id', 'readly-cover')
    el.setAttribute('href', href)
    el.setAttribute('media-type', img.type)
    if ((o.doc.documentElement.getAttribute('version') ?? '').startsWith('3')) el.setAttribute('properties', 'cover-image')
    manifest.appendChild(el)
    const meta = o.doc.createElementNS(ns, 'meta')
    meta.setAttribute('name', 'cover')
    meta.setAttribute('content', 'readly-cover')
    metadata.appendChild(meta)
    o.files[o.dir + href] = img.bytes
    if (!hadBackup) o.files[jsonPath] = strToU8(JSON.stringify({ href, mediaType: img.type, added: true } satisfies CoverBackup))
  }
  return saveOpf(o)
}

/** 恢复原封面（没换过就原样返回 null） */
export function restoreEpubCover(bytes: Uint8Array): Uint8Array | null {
  const o = openOpf(bytes)
  const jsonPath = o.dir + BACKUP_JSON
  if (!o.files[jsonPath]) return null
  const b = JSON.parse(strFromU8(o.files[jsonPath])) as CoverBackup
  const item = o.items.find(i => i.getAttribute('href') === b.href)
  if (b.added) {
    item?.remove()
    for (const m of Array.from(o.doc.getElementsByTagNameNS('*', 'meta')))
      if (m.getAttribute('name') === 'cover' && m.getAttribute('content') === 'readly-cover') m.remove()
    delete o.files[o.resolve(b.href)]
  } else {
    if (b.backup && o.files[o.dir + b.backup]) o.files[o.resolve(b.href)] = o.files[o.dir + b.backup]
    if (item && b.mediaType) item.setAttribute('media-type', b.mediaType)
    if (b.backup) delete o.files[o.dir + b.backup]
  }
  delete o.files[jsonPath]
  return saveOpf(o)
}
