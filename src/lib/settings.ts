import { builtinFontFaceCSS, customFontFaceCSS, MONO_STACK, resolveFont } from './fonts'
import type { CustomFont } from './types'
import { deviceClass } from './device'
import type { Motion, MotionSpeed } from './motion'
import type { Lang } from './i18n'

export type ReaderThemeId =
  | 'parchment'
  | 'ivory'
  | 'sage'
  | 'sand'
  | 'blossom'
  | 'kraft'
  | 'celadon'
  | 'night'
  | 'cocoa'
  | 'pine'
  | 'ink'
  | 'custom'

export const LIGHT_THEMES: ReaderThemeId[] = ['parchment', 'ivory', 'sand', 'kraft', 'sage', 'celadon', 'blossom']
export const DARK_THEMES: ReaderThemeId[] = ['night', 'cocoa', 'pine', 'ink']

export interface ReaderTheme {
  name: string
  bg: string
  fg: string
  muted: string
  link: string
  dark: boolean
}

/** 阅读主题：暖调中性色，不出现冷调蓝灰 */
export const READER_THEMES: Record<ReaderThemeId, ReaderTheme> = {
  parchment: { name: '羊皮纸', bg: '#f5f4ed', fg: '#141413', muted: '#87867f', link: '#c6613f', dark: false },
  ivory: { name: '象牙白', bg: '#faf9f5', fg: '#1f1e1d', muted: '#87867f', link: '#c6613f', dark: false },
  sand: { name: '暖砂', bg: '#eee3cf', fg: '#3d3226', muted: '#8a7a64', link: '#a5502f', dark: false },
  sage: { name: '鼠尾草', bg: '#e1e6d6', fg: '#262b20', muted: '#6f7a62', link: '#566641', dark: false },
  blossom: { name: '樱粉', bg: '#f7e8e4', fg: '#3b2522', muted: '#9a7b75', link: '#b8524a', dark: false },
  kraft: { name: '牛皮纸', bg: '#e4d3b4', fg: '#33281b', muted: '#7d6a4e', link: '#9a4b25', dark: false },
  celadon: { name: '青瓷', bg: '#dce7df', fg: '#1f2c25', muted: '#667a6d', link: '#3f6b55', dark: false },
  night: { name: '暖夜', bg: '#252523', fg: '#e8e6dc', muted: '#9c9a92', link: '#e08a6d', dark: true },
  cocoa: { name: '可可', bg: '#2a221d', fg: '#e9dccd', muted: '#a08c78', link: '#e0956c', dark: true },
  pine: { name: '松墨', bg: '#18201b', fg: '#d3dccf', muted: '#7f8f80', link: '#9cc08a', dark: true },
  ink: { name: '墨', bg: '#141413', fg: '#d6d3c8', muted: '#8a887f', link: '#d97757', dark: true },
  // 自定义背景：真正的颜色来自设置里的 customBg / customFg，见 readerTheme()
  custom: { name: '自定义', bg: '#f3efe4', fg: '#2a2622', muted: '#8a8478', link: '#c6613f', dark: false },
}

const hexRgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null
}
const mixHex = (a: string, b: string, t: number) => {
  const x = hexRgb(a)
  const y = hexRgb(b)
  if (!x || !y) return a
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')
}
/** 颜色的相对亮度（0 黑 ~ 1 白） */
export const luminance = (hex: string) => {
  const c = hexRgb(hex)
  return c ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 : 1
}

/** 按 id 取阅读主题；“自定义”用设置里你自己选的背景色与文字色 */
export function readerTheme(style: Pick<ReadingStyle, 'theme' | 'customBg' | 'customFg'>, id: ReaderThemeId = style.theme): ReaderTheme {
  if (id !== 'custom') return READER_THEMES[id] ?? READER_THEMES.parchment
  const base = READER_THEMES.custom
  const bg = hexRgb(style.customBg ?? '') ? style.customBg! : base.bg
  const dark = luminance(bg) < 0.42
  const fg = hexRgb(style.customFg ?? '') ? style.customFg! : dark ? '#e8e6dc' : '#1f1e1d'
  return { name: base.name, bg, fg, muted: mixHex(fg, bg, 0.45), link: dark ? '#e08a6d' : '#c6613f', dark }
}

export interface ReadingStyle {
  theme: ReaderThemeId
  /** 阅读页月亮按钮切换到的夜间背景 */
  darkTheme: ReaderThemeId
  /** 切到夜间前用的日间背景，再按一次月亮按钮回到它 */
  dayTheme?: ReaderThemeId
  /** 旧版：界面深色时阅读背景自动变深。现在阅读背景只手动切换，此项保留仅为兼容旧设置 */
  autoDark: boolean
  font: string
  fontSize: number
  lineHeight: number
  paragraphSpacing: number
  textIndent: number
  letterSpacing: number
  justify: boolean
  hyphenate: boolean
  /** 左右留白（占版心的百分比） */
  marginX: number
  /** 上下留白（px） */
  marginY: number
  maxWidth: number
  columns: 1 | 2
  /** 覆盖书籍自带的行距/段距/缩进 */
  overrideLayout: boolean
  /** 覆盖书籍自带的文字和背景颜色 */
  overrideColors: boolean
  /** “自定义”阅读背景的背景色与文字色 */
  customBg?: string
  customFg?: string
  /** 阅读时的屏幕亮度：0.02 ~ 1；-1 表示跟随系统 */
  brightness: number
}

export type StatusItem =
  | 'none'
  | 'chapter'
  | 'title'
  | 'clock'
  | 'progress'
  | 'chapterPage'
  | 'chapterLeft'
  | 'battery'
  | 'sessionTime'

export const STATUS_ITEMS: [StatusItem, string][] = [
  ['none', '不显示'],
  ['chapter', '章节名'],
  ['title', '书名'],
  ['clock', '时间'],
  ['progress', '全书进度'],
  ['chapterPage', '本章页码'],
  ['chapterLeft', '本章剩余页数'],
  ['battery', '电量'],
  ['sessionTime', '本次阅读时长'],
]

/** 页眉页脚的 6 个区域：上左/上中/上右/下左/下中/下右 */
export type StatusZone = 'tl' | 'tc' | 'tr' | 'bl' | 'bc' | 'br'
export type StatusConfig = Record<Exclude<StatusItem, 'none'>, { on: boolean; zone: StatusZone }>

export const DEFAULT_STATUS: StatusConfig = {
  clock: { on: true, zone: 'tl' },
  battery: { on: false, zone: 'tr' },
  title: { on: false, zone: 'tc' },
  chapter: { on: true, zone: 'bl' },
  progress: { on: true, zone: 'br' },
  chapterPage: { on: false, zone: 'bc' },
  chapterLeft: { on: false, zone: 'bc' },
  sessionTime: { on: false, zone: 'tr' },
}

/** 界面主题色 */
export type AccentId = 'terracotta' | 'amber' | 'sage' | 'rose' | 'plum' | 'ocean' | 'system' | 'custom'
export const ACCENTS: { id: Exclude<AccentId, 'system' | 'custom'>; name: string; color: string }[] = [
  { id: 'terracotta', name: '赤陶', color: '#d97757' },
  { id: 'amber', name: '琥珀', color: '#d4912a' },
  { id: 'sage', name: '鼠尾草', color: '#6f8a5c' },
  { id: 'rose', name: '玫瑰', color: '#c8607a' },
  { id: 'plum', name: '葡萄', color: '#8a6aa8' },
  { id: 'ocean', name: '海雾', color: '#4f8aa0' },
]

export interface Behavior {
  flow: 'paginated' | 'scrolled'
  animated: boolean
  tapToTurn: boolean
  /** sides：左侧上一页、右侧下一页；next：两侧都是下一页 */
  tapMode: 'sides' | 'next'
  wheelTurn: boolean
  showStatusBar: boolean
  showClock: boolean
  /** 旧版的三个槽位（只用于迁移到 status） */
  header: StatusItem
  footerLeft: StatusItem
  footerRight: StatusItem
  /** 页眉页脚：每项信息各自开关、各自放在哪个区域 */
  status?: StatusConfig
  /** 页眉页脚字号 */
  statusSize: 'sm' | 'md' | 'lg'
  autoHideCursor: boolean
  /** 打开书籍前先从云端拉取最新进度 */
  syncOnOpen: boolean
  /** 安卓阅读时隐藏状态栏与底部小白条 */
  immersive: boolean
  /** 安卓：音量键翻页（默认关闭） */
  volumeKeys: boolean
  /** 阅读工具栏里显示可拖动的全书进度条（默认不显示，容易误触） */
  showSlider: boolean
  /** 进度滑块拖的是全书进度还是本章进度 */
  sliderMode: 'book' | 'chapter'
}

/** 书架排序方式 */
export type ShelfSort = 'recent' | 'added' | 'title' | 'author' | 'progress'
export const SHELF_SORTS: [ShelfSort, string][] = [
  ['recent', '最近阅读'],
  ['added', '加入时间'],
  ['title', '书名'],
  ['author', '作者'],
  ['progress', '阅读进度'],
]

export interface Settings {
  /** 是否已看过首次启动的引导（旧版本升级上来的视为看过） */
  onboarded: boolean
  /** 自选的主题色（accent 为 custom 时使用） */
  accentCustom: string
  /** 书架分类功能 */
  shelfCategories: boolean
  shelfSort: ShelfSort
  /** 书架每本书下方显示的信息：书名+作者+进度 / 只有书名 / 只有封面 */
  shelfInfo: 'full' | 'title' | 'cover'
  /** 打开、合上书的动画：翻开封面 / 简单淡入 */
  bookAnim: 'open' | 'fade' | 'emerge' | 'runes'
  /** 动画速度 */
  motionSpeed: MotionSpeed
  /** 单本模式：用当前这本书的封面做一层模糊渐变的背景 */
  shelfBackdrop: boolean
  /** 底部导航显示文字标签 */
  dockLabels: boolean
  /** 界面语言 */
  lang: Lang
  appTheme: 'system' | 'light' | 'dark'
  /** 玻璃通透度：越通透越能看到背后的莫奈背景 */
  glass: 'clear' | 'standard' | 'frosted'
  /** 莫奈背景强度 */
  monetLevel: 'subtle' | 'standard' | 'vivid'
  /** 长按、切换时的轻微震动 */
  haptics: boolean
  /** 启动时直接打开上次读的书 */
  resumeLast: boolean
  /** 阅读时保持屏幕常亮（安卓） */
  keepAwake: boolean
  /** 启动时自动检查更新 */
  autoUpdate: boolean
  uiFont: string
  monet: boolean
  /** 动画风格：柔和渐变 / 灵动弹性 / 关闭 */
  motion: Motion
  accent: AccentId
  /** 从系统“打开方式”打开书籍时：每次询问 / 默认上传云端 / 默认仅本机 */
  openFile: 'ask' | 'upload' | 'local'
  /** 书架每排几本：1 为单本轮播 */
  shelfColumns: number
  reading: ReadingStyle
  behavior: Behavior
  updatedAt: number
}

export const DEFAULT_SETTINGS: Settings = {
  onboarded: true,
  accentCustom: '#d97757',
  shelfCategories: false,
  shelfSort: 'recent',
  shelfInfo: 'full',
  bookAnim: 'open',
  motionSpeed: 'normal',
  shelfBackdrop: false,
  dockLabels: true,
  lang: 'zh',
  appTheme: 'system',
  glass: 'clear',
  monetLevel: 'standard',
  haptics: true,
  resumeLast: false,
  keepAwake: true,
  autoUpdate: true,
  uiFont: 'anthropic-sans',
  monet: true,
  motion: 'soft',
  accent: 'terracotta',
  openFile: 'ask',
  shelfColumns: deviceClass === 'mobile' ? 3 : 6,
  reading: {
    theme: 'parchment',
    darkTheme: 'night',
    autoDark: false,
    font: 'anthropic-serif',
    fontSize: 19,
    lineHeight: 1.8,
    paragraphSpacing: 0.6,
    textIndent: 2,
    letterSpacing: 0.02,
    justify: true,
    hyphenate: false,
    marginX: 6,
    marginY: 44,
    maxWidth: 760,
    columns: 2,
    overrideLayout: true,
    overrideColors: true,
    customBg: '#f3efe4',
    customFg: '#2a2622',
    brightness: -1,
  },
  behavior: {
    flow: 'paginated',
    animated: true,
    tapToTurn: true,
    tapMode: 'sides',
    wheelTurn: true,
    showStatusBar: true,
    showClock: true,
    header: 'clock',
    footerLeft: 'chapter',
    footerRight: 'progress',
    status: DEFAULT_STATUS,
    statusSize: 'md',
    autoHideCursor: true,
    syncOnOpen: true,
    immersive: true,
    volumeKeys: false,
    showSlider: false,
    sliderMode: 'book',
  },
  updatedAt: 0,
}

export function mergeSettings(saved: Partial<Settings> | null | undefined): Settings {
  const behavior = { ...DEFAULT_SETTINGS.behavior, ...saved?.behavior }
  // 旧版默认是“页眉章节名 + 页脚左时间”，章节名会压到正文：迁移到“左上时间 + 左下章节”
  if (behavior.header === 'chapter' && behavior.footerLeft === 'clock') {
    behavior.header = 'clock'
    behavior.footerLeft = 'chapter'
  }
  // 旧版三个槽位 → 新版“每项各自开关与区域”
  if (!saved?.behavior?.status) {
    const status = Object.fromEntries(
      Object.entries(DEFAULT_STATUS).map(([k, v]) => [k, { ...v, on: false }]),
    ) as StatusConfig
    const put = (item: StatusItem, zone: StatusZone) => {
      if (item !== 'none') status[item] = { on: true, zone }
    }
    put(behavior.header, 'tl')
    put(behavior.footerLeft, 'bl')
    put(behavior.footerRight, 'br')
    behavior.status = status
  } else {
    behavior.status = { ...DEFAULT_STATUS, ...saved.behavior.status }
  }
  // 旧版：阅读页的月亮按钮会把整个界面固定成浅色/深色，导致书架等界面不再跟随系统夜间模式。
  // 新版阅读背景独立切换，迁移一次：界面恢复“跟随系统”
  const legacyTheme = !!saved?.reading && saved.reading.autoDark !== false
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    ...(legacyTheme ? { appTheme: 'system' as const } : {}),
    reading: { ...DEFAULT_SETTINGS.reading, ...saved?.reading, ...(legacyTheme ? { autoDark: false } : {}) },
    behavior,
  }
}

/** 阅读背景只由你手动选择/切换，不再跟随界面深浅色 */
export function activeReaderTheme(style: ReadingStyle): ReaderTheme {
  return readerTheme(style)
}

/** 生成注入书页 iframe 的 CSS */
export function bookCSS(style: ReadingStyle, theme: ReaderTheme, customFonts: CustomFont[], forceLayout: boolean) {
  const font = resolveFont(style.font, customFonts, true)
  const layout = style.overrideLayout || forceLayout
  const colors = style.overrideColors
  return `@namespace epub "http://www.idpf.org/2007/ops";
${builtinFontFaceCSS()}
${customFontFaceCSS(customFonts)}
html {
  color-scheme: ${theme.dark ? 'dark' : 'light'};
  color: ${theme.fg};
  background: ${theme.bg} !important;
  font-size: ${style.fontSize}px !important;
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
}
body {
  ${font.family ? `font-family: ${font.family} !important;` : ''}
  font-size: 1rem !important;
  letter-spacing: ${style.letterSpacing}em;
  ${colors ? `color: ${theme.fg} !important; background: transparent !important;` : ''}
}
${font.family ? `body *:not(code):not(pre):not(kbd):not(samp) { font-family: inherit !important; }` : ''}
code, pre, kbd, samp { font-family: ${MONO_STACK} !important; }
${
  colors
    ? `body *:not(img):not(svg):not(svg *) { color: inherit !important; background-color: transparent !important; border-color: ${theme.muted}55 !important; }
a, a * { color: ${theme.link} !important; }`
    : ''
}
p, li, blockquote, dd, div {
  ${layout ? `line-height: ${style.lineHeight} !important;` : ''}
  text-align: ${style.justify ? 'justify' : 'start'};
  hyphens: ${style.hyphenate ? 'auto' : 'manual'};
  -webkit-hyphens: ${style.hyphenate ? 'auto' : 'manual'};
  widows: 2; orphans: 2;
}
${
  layout
    ? `p { margin-top: 0 !important; margin-bottom: ${style.paragraphSpacing}em !important; text-indent: ${style.textIndent}em !important; }
p[align="center"], p.center, p[style*="center"] { text-indent: 0 !important; }`
    : ''
}
h1, h2, h3, h4 { line-height: 1.4 !important; font-weight: 500; text-indent: 0 !important; }
[align="left"] { text-align: left; } [align="right"] { text-align: right; }
[align="center"] { text-align: center; } [align="justify"] { text-align: justify; }
img, svg, video { max-width: 100%; height: auto; object-fit: contain; ${theme.dark ? 'filter: brightness(.88);' : ''} }
pre { white-space: pre-wrap !important; }
::selection { background: ${theme.link}44; }
aside[epub|type~="footnote"], aside[epub|type~="endnote"], aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
`
}
