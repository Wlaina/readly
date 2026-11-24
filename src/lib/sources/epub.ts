/**
 * 把书源下载下来的书打包成 EPUB 3：每卷一个卷首页，每章一个 XHTML，插图和封面放进 images/。
 * 来源记在 dc:source、dc:identifier（urn:readly-source:<书源>:<书号>）和 OEBPS/readly-source.json 里，
 * 追更时据此知道已经有哪些卷、哪些章。
 *
 * 追更（appendEpub）只往书的**末尾**追加：新卷，或最后一卷新出的章节。前面的文件名、顺序都不变，
 * 所以阅读进度、书签、笔记（都按书里的位置记）不会错位。
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import type { ChapterContent, SourceBook } from './types'

export interface EpubChapter {
  id?: string
  title: string
  content: ChapterContent
}

export interface EpubVolume {
  id?: string
  title: string
  chapters: EpubChapter[]
}

export interface EpubImage {
  bytes: Uint8Array
  type: string
}

/** 书里已经有哪些卷、章（存在 OEBPS/readly-source.json，也同步记在书架记录上） */
export interface SourceManifest {
  source: string
  id: string
  /**
   * 书里的卷（按阅读顺序）。file：这一卷在书里的文件序号（v001.xhtml 是 0）；
   * 旧的书没有这一项，那时只会往末尾追加，序号就是卷的位置
   */
  volumes: { id: string; title: string; chapters: string[]; file?: number }[]
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

export function imageType(bytes: Uint8Array): { mime: string; ext: string } | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' }
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { mime: 'image/png', ext: 'png' }
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return { mime: 'image/gif', ext: 'gif' }
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return { mime: 'image/webp', ext: 'webp' }
  return null
}

const page = (title: string, body: string) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>`

const CSS = `body { margin: 0; }
h1.volume { margin: 30% 0 0; text-align: center; font-size: 1.6em; }
h2 { font-size: 1.3em; margin: 1em 0 1.2em; }
p { text-indent: 2em; margin: 0 0 .5em; line-height: 1.7; }
p.blank { text-indent: 0; }
div.illus { text-align: center; margin: 1em 0; text-indent: 0; }
div.illus img { max-width: 100%; max-height: 95vh; }
`

const pad = (n: number, w: number) => String(n).padStart(w, '0')
const volFile = (vi: number) => `v${pad(vi + 1, 3)}.xhtml`
const chapFile = (vi: number, ci: number) => `v${pad(vi + 1, 3)}c${pad(ci + 1, 4)}.xhtml`

/** 往书里写章节、插图时共用的状态 */
class Writer {
  files: Zippable = {}
  manifest: string[] = []
  spine: string[] = []
  private imageNames = new Map<string, string>()
  constructor(
    private images: Map<string, EpubImage>,
    private imgSeq = 0,
  ) {}

  addImage(img: EpubImage, name?: string) {
    const t = imageType(img.bytes)
    if (!t) return ''
    const file = `images/${name ?? `img${pad(++this.imgSeq, 4)}`}.${t.ext}`
    this.files[`OEBPS/${file}`] = [img.bytes, { level: 0 }]
    this.manifest.push(`<item id="${file.replace(/[/.]/g, '_')}" href="${file}" media-type="${t.mime}"${name === 'cover' ? ' properties="cover-image"' : ''}/>`)
    return file
  }

  volume(vi: number, title: string) {
    const f = volFile(vi)
    this.files[`OEBPS/${f}`] = strToU8(page(title, `<h1 class="volume">${esc(title)}</h1>`))
    this.manifest.push(`<item id="v${vi}" href="${f}" media-type="application/xhtml+xml"/>`)
    this.spine.push(`<itemref idref="v${vi}"/>`)
    return f
  }

  chapter(vi: number, ci: number, ch: EpubChapter) {
    const f = chapFile(vi, ci)
    const body: string[] = [`<h2>${esc(ch.title)}</h2>`]
    for (const b of ch.content.blocks) {
      if (b.type === 'p') body.push(`<p>${esc(b.text)}</p>`)
      else {
        let name = this.imageNames.get(b.src)
        if (name === undefined) {
          const img = this.images.get(b.src)
          name = img ? this.addImage(img) : ''
          this.imageNames.set(b.src, name)
        }
        // 没下载到的图记下原地址，以后“补全插图”时直接用
        body.push(name ? `<div class="illus"><img src="${name}" alt=""/></div>` : `<p class="blank" data-src="${esc(b.src)}">[插图]</p>`)
      }
    }
    this.files[`OEBPS/${f}`] = strToU8(page(ch.title, body.join('\n')))
    this.manifest.push(`<item id="v${vi}c${ci}" href="${f}" media-type="application/xhtml+xml"/>`)
    this.spine.push(`<itemref idref="v${vi}c${ci}"/>`)
    return f
  }
}

/** 图片本来就是压缩过的，再压一遍几乎不变小却很慢（60MB 的书要 2 秒多，界面会卡住）：直接存 */
const IMG = /\.(jpe?g|png|gif|webp|avif)$/i
const zip = (files: Zippable) =>
  // mimetype 必须是第一个文件且不压缩
  zipSync(
    {
      mimetype: [strToU8('application/epub+zip'), { level: 0 }],
      ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v instanceof Uint8Array && IMG.test(k) ? [v, { level: 0 }] : v])),
    },
    { level: 6 },
  )

/**
 * images：正文里每个图片地址对应下载好的图片（没下载成功的就留一行“[插图]”）。
 * cover：封面图片；没有就不设封面。
 */
export function buildEpub(
  book: SourceBook,
  sourceUrl: string,
  volumes: EpubVolume[],
  images: Map<string, EpubImage>,
  cover: EpubImage | null,
  manifest: SourceManifest,
): Uint8Array {
  const w = new Writer(images)
  const nav: string[] = []
  if (cover) w.addImage(cover, 'cover')
  volumes.forEach((vol, vi) => {
    const vf = w.volume(vi, vol.title)
    const items = vol.chapters.map((ch, ci) => `<li><a href="${w.chapter(vi, ci, ch)}">${esc(ch.title)}</a></li>`)
    nav.push(`<li><a href="${vf}">${esc(vol.title)}</a>${items.length ? `<ol>${items.join('')}</ol>` : ''}</li>`)
  })

  w.files['OEBPS/style.css'] = strToU8(CSS)
  w.files['OEBPS/readly-source.json'] = strToU8(JSON.stringify(manifest))
  w.files['OEBPS/nav.xhtml'] = strToU8(page(book.title, `<nav epub:type="toc" id="toc"><h1>${esc(book.title)}</h1><ol>${nav.join('\n')}</ol></nav>`))
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:readly-source:${esc(book.source)}:${esc(book.id)}</dc:identifier>
<dc:title>${esc(book.title)}</dc:title>
<dc:creator>${esc(book.author)}</dc:creator>
<dc:language>zh-CN</dc:language>
<dc:source>${esc(sourceUrl)}</dc:source>
${book.description ? `<dc:description>${esc(book.description)}</dc:description>` : ''}
${book.tags.map(t => `<dc:subject>${esc(t)}</dc:subject>`).join('\n')}
<meta property="dcterms:modified">${modified}</meta>
${cover ? '<meta name="cover" content="images_cover_' + (imageType(cover.bytes)?.ext ?? 'jpg') + '"/>' : ''}
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="readly-source" href="readly-source.json" media-type="application/json"/>
${w.manifest.join('\n')}
</manifest>
<spine>
${w.spine.join('\n')}
</spine>
</package>`
  w.files['OEBPS/content.opf'] = strToU8(opf)
  w.files['META-INF/container.xml'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
  return zip(w.files)
}

/** 读出 Readly 下载的 EPUB 里记录的来源；不是 Readly 从书源下载的书返回 null */
export function readManifest(bytes: Uint8Array): SourceManifest | null {
  try {
    const f = unzipSync(bytes, {
      filter: e => e.name === 'OEBPS/readly-source.json',
    })['OEBPS/readly-source.json']
    return f ? (JSON.parse(strFromU8(f)) as SourceManifest) : null
  } catch {
    return null
  }
}

/** 追加的一卷：before 是书里某一卷的文件序号，插到它前面（补上当初没下载的中间卷）；不填就接在末尾 */
export interface AddVolume extends EpubVolume {
  before?: number
}

/**
 * 追更：往已有的书里加内容。
 * - toLast：最后一卷新出的章节（接在最后一卷后面）；lastFile 是最后一卷的文件序号
 * - volumes：新的卷，接在末尾或插到中间
 * - manifest：拿到新卷的文件序号后，给出要写进书里的来源记录
 * 返回新的 EPUB，以及阅读顺序的变化 remap[旧位置] = 新位置（插到中间时，后面的位置都会后移，
 * 进度、书签、笔记要按它改写）。书里原有的内容、文件名都不变。
 */
export function appendEpub(
  bytes: Uint8Array,
  add: { toLast: EpubChapter[]; volumes: AddVolume[]; lastFile?: number },
  images: Map<string, EpubImage>,
  manifest: (files: number[]) => SourceManifest,
  /** 更清楚的封面：换掉书里原来的（只换封面图片本身，正文不动） */
  cover?: EpubImage | null,
): { bytes: Uint8Array; remap: number[] } {
  const files = unzipSync(bytes)
  delete files.mimetype
  const names = Object.keys(files)
  const maxVol = Math.max(-1, ...names.map(n => Number(n.match(/^OEBPS\/v(\d{3})\.xhtml$/)?.[1] ?? 0) - 1))
  const lastVol = add.lastFile ?? maxVol
  const imgSeq = Math.max(0, ...names.map(n => Number(n.match(/^OEBPS\/images\/img(\d+)\./)?.[1] ?? 0)))
  const w = new Writer(images, imgSeq)

  const opfDoc = new DOMParser().parseFromString(strFromU8(files['OEBPS/content.opf']), 'application/xml')
  const OPF = 'http://www.idpf.org/2007/opf'
  const spine = opfDoc.getElementsByTagNameNS(OPF, 'spine')[0]
  const idrefs = () => [...spine.getElementsByTagNameNS(OPF, 'itemref')].map(i => i.getAttribute('idref') ?? '')
  const oldOrder = idrefs()

  // 目录：在原有目录上加
  const navDoc = new DOMParser().parseFromString(strFromU8(files['OEBPS/nav.xhtml']), 'application/xhtml+xml')
  const XHTML = 'http://www.w3.org/1999/xhtml'
  const topOl = navDoc.querySelector('nav > ol')
  const li = (href: string, title: string) => {
    const el = navDoc.createElementNS(XHTML, 'li')
    const a = navDoc.createElementNS(XHTML, 'a')
    a.setAttribute('href', href)
    a.textContent = title
    el.appendChild(a)
    return el
  }
  /** 目录里某一卷的条目 */
  const volLi = (vi: number) => [...(topOl?.children ?? [])].find(e => e.querySelector('a')?.getAttribute('href') === volFile(vi))

  // 每段新内容在阅读顺序里的条目，以及要插到哪一卷前面（不填 = 末尾）
  const chunks: { spine: string[]; before?: number }[] = []
  if (add.toLast.length && lastVol >= 0) {
    const existing = names.filter(n => new RegExp(`^OEBPS/v${pad(lastVol + 1, 3)}c\\d{4}\\.xhtml$`).test(n)).length
    const last = volLi(lastVol) ?? topOl?.lastElementChild
    let sub: Element | null | undefined = last?.querySelector('ol')
    if (last && !sub) {
      sub = navDoc.createElementNS(XHTML, 'ol')
      last.appendChild(sub)
    }
    const s0 = w.spine.length
    add.toLast.forEach((ch, i) => sub?.appendChild(li(w.chapter(lastVol, existing + i, ch), ch.title)))
    chunks.push({ spine: w.spine.slice(s0) })
  }
  const added: number[] = []
  add.volumes.forEach((vol, k) => {
    const vi = maxVol + 1 + k
    added.push(vi)
    const s0 = w.spine.length
    const item = li(w.volume(vi, vol.title), vol.title)
    if (vol.chapters.length) {
      const sub = navDoc.createElementNS(XHTML, 'ol')
      vol.chapters.forEach((ch, ci) => sub.appendChild(li(w.chapter(vi, ci, ch), ch.title)))
      item.appendChild(sub)
    }
    const target = vol.before !== undefined ? volLi(vol.before) : undefined
    if (target) topOl?.insertBefore(item, target)
    else topOl?.appendChild(item)
    chunks.push({ spine: w.spine.slice(s0), before: target ? vol.before : undefined })
  })
  files['OEBPS/nav.xhtml'] = strToU8(new XMLSerializer().serializeToString(navDoc))

  // 包文件：清单、阅读顺序（插到中间的放到那一卷前面），更新修改时间
  const frag = (xml: string) =>
    [...new DOMParser().parseFromString(`<x xmlns="${OPF}">${xml}</x>`, 'application/xml').documentElement.children].map(n => opfDoc.importNode(n, true))
  const man = opfDoc.getElementsByTagNameNS(OPF, 'manifest')[0]
  for (const n of frag(w.manifest.join(''))) man.appendChild(n)
  for (const c of chunks) {
    const target =
      c.before !== undefined ? [...spine.getElementsByTagNameNS(OPF, 'itemref')].find(i => i.getAttribute('idref') === `v${c.before}`) : undefined
    for (const n of frag(c.spine.join(''))) {
      if (target) spine.insertBefore(n, target)
      else spine.appendChild(n)
    }
  }
  if (!opfDoc.querySelector('[id="readly-source"]'))
    for (const n of frag('<item id="readly-source" href="readly-source.json" media-type="application/json"/>')) man.appendChild(n)
  const mod = [...opfDoc.getElementsByTagNameNS(OPF, 'meta')].find(m => m.getAttribute('property') === 'dcterms:modified')
  if (mod) mod.textContent = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  files['OEBPS/readly-source.json'] = strToU8(JSON.stringify(manifest(added)))

  // 换封面：沿用原来的清单条目，只改文件内容（扩展名不同就连同 href、类型一起改）
  const t = cover && imageType(cover.bytes)
  if (cover && t) {
    const item = [...opfDoc.getElementsByTagNameNS(OPF, 'item')].find(i => (i.getAttribute('properties') ?? '').includes('cover-image'))
    if (item) {
      const oldHref = item.getAttribute('href') ?? ''
      const newHref = oldHref.replace(/\.[a-z]+$/i, `.${t.ext}`)
      delete files[`OEBPS/${oldHref}`]
      files[`OEBPS/${newHref}`] = cover.bytes
      item.setAttribute('href', newHref)
      item.setAttribute('media-type', t.mime)
    }
  }
  files['OEBPS/content.opf'] = strToU8(new XMLSerializer().serializeToString(opfDoc))

  const newOrder = idrefs()
  const remap = oldOrder.map(id => newOrder.indexOf(id))
  return { bytes: zip({ ...files, ...w.files }), remap }
}

/**
 * 整理书里的卷：remove 删掉这些卷（文件序号），rename 把卷改名（文件序号 → 新卷名，目录和卷首页一起改）。
 * 返回新的 EPUB，以及阅读顺序的变化 remap[旧位置] = 新位置（删掉的项算到它后面第一个留下的项上）
 */
export function editVolumes(
  bytes: Uint8Array,
  ops: { remove: number[]; rename: Record<number, string> },
  manifest: SourceManifest,
): { bytes: Uint8Array; remap: number[] } {
  const files = unzipSync(bytes)
  delete files.mimetype
  const OPF = 'http://www.idpf.org/2007/opf'
  const opfDoc = new DOMParser().parseFromString(strFromU8(files['OEBPS/content.opf']), 'application/xml')
  const spine = opfDoc.getElementsByTagNameNS(OPF, 'spine')[0]
  const idrefs = () => [...spine.getElementsByTagNameNS(OPF, 'itemref')].map(i => i.getAttribute('idref') ?? '')
  const oldOrder = idrefs()
  const gone = (id: string) => ops.remove.some(vi => id === `v${vi}` || id.startsWith(`v${vi}c`))

  for (const ref of [...spine.getElementsByTagNameNS(OPF, 'itemref')]) if (gone(ref.getAttribute('idref') ?? '')) ref.remove()
  for (const item of [...opfDoc.getElementsByTagNameNS(OPF, 'item')]) {
    if (!gone(item.getAttribute('id') ?? '')) continue
    delete files[`OEBPS/${item.getAttribute('href')}`]
    item.remove()
  }

  const navDoc = new DOMParser().parseFromString(strFromU8(files['OEBPS/nav.xhtml']), 'application/xhtml+xml')
  const topOl = navDoc.querySelector('nav > ol')
  const volLi = (vi: number) => [...(topOl?.children ?? [])].find(e => e.querySelector('a')?.getAttribute('href') === volFile(vi))
  for (const vi of ops.remove) volLi(vi)?.remove()
  for (const [k, title] of Object.entries(ops.rename)) {
    const vi = Number(k)
    const a = volLi(vi)?.querySelector('a')
    if (a) a.textContent = title
    if (files[`OEBPS/${volFile(vi)}`]) files[`OEBPS/${volFile(vi)}`] = strToU8(page(title, `<h1 class="volume">${esc(title)}</h1>`))
  }
  files['OEBPS/nav.xhtml'] = strToU8(new XMLSerializer().serializeToString(navDoc))

  const mod = [...opfDoc.getElementsByTagNameNS(OPF, 'meta')].find(m => m.getAttribute('property') === 'dcterms:modified')
  if (mod) mod.textContent = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  files['OEBPS/content.opf'] = strToU8(new XMLSerializer().serializeToString(opfDoc))
  files['OEBPS/readly-source.json'] = strToU8(JSON.stringify(manifest))

  const newOrder = idrefs()
  const remap = oldOrder.map((_, i) => {
    for (let j = i; j < oldOrder.length; j++) {
      const k = newOrder.indexOf(oldOrder[j])
      if (k >= 0) return k
    }
    return Math.max(0, newOrder.length - 1)
  })
  return { bytes: zip(files), remap }
}

/* ---------- 补全插图 ---------- */

/** 一章里所有插图的位置：已有的图和没下载到的“[插图]”占位，按出现的先后 */
const SLOT = /<div class="illus"><img src="[^"]*" alt=""\/><\/div>|<p class="blank"(?: data-src="([^"]*)")?>\[插图\]<\/p>/g

export interface MissingChapter {
  /** 章节文件，例如 OEBPS/v002c0001.xhtml */
  file: string
  title: string
  /** 这一章一共有几个插图位置 */
  slots: number
  /** 没下载到的位置（第几个插图位置）和记下的原地址（旧版本下载的书没有） */
  blanks: { index: number; src?: string }[]
}

const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** 找出书里没下载到的插图（只看书库下载的书写出的章节文件） */
export function missingImages(bytes: Uint8Array): MissingChapter[] {
  const files = unzipSync(bytes, { filter: f => /^OEBPS\/v\d{3}c\d{4}\.xhtml$/.test(f.name) })
  const out: MissingChapter[] = []
  for (const name of Object.keys(files).sort()) {
    const text = strFromU8(files[name])
    if (!text.includes('[插图]')) continue
    const blanks: MissingChapter['blanks'] = []
    let k = 0
    for (const m of text.matchAll(SLOT)) {
      if (m[0].startsWith('<p')) blanks.push({ index: k, src: m[1] ? unesc(m[1]) : undefined })
      k++
    }
    if (blanks.length) out.push({ file: name, title: unesc(text.match(/<title>([^<]*)<\/title>/)?.[1] ?? ''), slots: k, blanks })
  }
  return out
}

/**
 * 把补下载的插图放回书里：fills 是 章节文件 → (第几个插图位置 → 图片)。
 * 返回新的 EPUB 和补上的张数；书里原有的内容、文件名、阅读顺序都不变（进度、书签不受影响）
 */
export function fillImages(bytes: Uint8Array, fills: Map<string, Map<number, EpubImage>>): { bytes: Uint8Array; filled: number } {
  const files = unzipSync(bytes)
  delete files.mimetype
  let seq = Math.max(0, ...Object.keys(files).map(n => Number(n.match(/^OEBPS\/images\/img(\d+)\./)?.[1] ?? 0)))
  const items: string[] = []
  let filled = 0
  for (const [file, byIndex] of fills) {
    if (!files[file] || !byIndex.size) continue
    let k = 0
    const text = strFromU8(files[file]).replace(SLOT, m => {
      const i = k++
      const img = m.startsWith('<p') ? byIndex.get(i) : undefined
      const t = img && imageType(img.bytes)
      if (!img || !t) return m
      const name = `images/img${pad(++seq, 4)}.${t.ext}`
      files[`OEBPS/${name}`] = img.bytes
      items.push(`<item id="${name.replace(/[/.]/g, '_')}" href="${name}" media-type="${t.mime}"/>`)
      filled++
      return `<div class="illus"><img src="${name}" alt=""/></div>`
    })
    files[file] = strToU8(text)
  }
  if (!filled) return { bytes, filled }
  const opf = strFromU8(files['OEBPS/content.opf'])
  files['OEBPS/content.opf'] = strToU8(opf.replace('</manifest>', `${items.join('\n')}\n</manifest>`))
  return { bytes: zip(files), filled }
}
