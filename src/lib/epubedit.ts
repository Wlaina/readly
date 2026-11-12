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
