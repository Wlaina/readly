import type { CustomFont } from './types'

export interface FontOption {
  id: string
  name: string
  family: string | null
  kind: 'builtin' | 'system' | 'custom' | 'book'
}

export const SERIF_STACK = `"Anthropic Serif", "Anthropic Serif SC", Georgia, "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", SimSun, serif`
export const SANS_STACK = `"Anthropic Sans", "Anthropic Sans SC", -apple-system, BlinkMacSystemFont, Inter, "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", sans-serif`
export const MONO_STACK = `"Anthropic Mono", Consolas, Menlo, "Cascadia Mono", monospace`

export const BUILTIN_FONTS: FontOption[] = [
  { id: 'anthropic-serif', name: 'Anthropic Serif', family: SERIF_STACK, kind: 'builtin' },
  { id: 'anthropic-sans', name: 'Anthropic Sans', family: SANS_STACK, kind: 'builtin' },
  { id: 'system-serif', name: '系统宋体', family: `"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", SimSun, serif`, kind: 'system' },
  { id: 'system-sans', name: '系统黑体', family: `"Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", sans-serif`, kind: 'system' },
  { id: 'system-kai', name: '系统楷体', family: `KaiTi, STKaiti, "Kaiti SC", serif`, kind: 'system' },
]

export const BOOK_FONT: FontOption = { id: 'book', name: '书籍原字体', family: null, kind: 'book' }

const fontUrl = (file: string) => new URL(`/fonts/${file}`, location.href).href

/** 内置字体的 @font-face，需要使用绝对地址，因为书页运行在 blob: iframe 里 */
export function builtinFontFaceCSS() {
  const face = (family: string, file: string, format: string) =>
    `@font-face{font-family:"${family}";src:url("${fontUrl(file)}") format("${format}");font-display:swap;}`
  return [
    face('Anthropic Serif', 'AnthropicSerif-Roman-Web.woff2', 'woff2'),
    face('Anthropic Sans', 'AnthropicSans-Roman-Web.woff2', 'woff2'),
    face('Anthropic Mono', 'AnthropicMono-Roman-Web.woff2', 'woff2'),
    face('Anthropic Serif SC', 'AnthropicSerifSC-Regular.woff2', 'woff2'),
    face('Anthropic Sans SC', 'AnthropicSansSC-Regular.woff2', 'woff2'),
  ].join('\n')
}

/* ---------- 自定义字体（用户导入的 ttf/otf/woff/woff2） ---------- */

const blobUrls = new Map<string, string>()

export const customFamily = (f: CustomFont) => `"Readly Custom ${f.id}"`

export function customFontOptions(fonts: CustomFont[]): FontOption[] {
  return fonts.map(f => ({ id: `custom:${f.id}`, name: f.name, family: `${customFamily(f)}, ${SANS_STACK}`, kind: 'custom' }))
}

export function registerCustomFont(f: CustomFont, bytes: Uint8Array) {
  const mime = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' }[f.ext] ?? 'font/ttf'
  const old = blobUrls.get(f.id)
  if (old) URL.revokeObjectURL(old)
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  blobUrls.set(f.id, url)
  const face = new FontFace(customFamily(f).replace(/"/g, ''), `url(${url})`)
  face.load().then(loaded => document.fonts.add(loaded)).catch(e => console.error('字体加载失败', f.name, e))
}

export function unregisterCustomFont(id: string) {
  const url = blobUrls.get(id)
  if (url) URL.revokeObjectURL(url)
  blobUrls.delete(id)
  for (const face of document.fonts) if (face.family.includes(`Readly Custom ${id}`)) document.fonts.delete(face)
}

export function customFontFaceCSS(fonts: CustomFont[]) {
  return fonts
    .filter(f => blobUrls.has(f.id))
    .map(f => `@font-face{font-family:${customFamily(f)};src:url("${blobUrls.get(f.id)}");font-display:swap;}`)
    .join('\n')
}

export function resolveFont(id: string, custom: CustomFont[], allowBook: boolean): FontOption {
  if (allowBook && id === 'book') return BOOK_FONT
  if (id.startsWith('local:')) {
    const name = id.slice(6)
    return { id, name, family: `"${name}", ${SANS_STACK}`, kind: 'system' }
  }
  return (
    BUILTIN_FONTS.find(f => f.id === id) ??
    customFontOptions(custom).find(f => f.id === id) ??
    (allowBook ? BUILTIN_FONTS[0] : BUILTIN_FONTS[1])
  )
}
