import { ACCENTS, type AccentId } from './settings'
import { isTauri } from './storage'

const DEFAULT = ACCENTS[0].color

const hexToRgb = (hex: string) => {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  return m ? m.slice(1).map(x => parseInt(x, 16)) : null
}
const rgbToHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')

/** 主题色太亮或太灰时做一点修正，保证白字按钮可读 */
export function normalizeAccent(hex: string) {
  const rgb = hexToRgb(hex)
  if (!rgb) return DEFAULT
  const [r, g, b] = rgb
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  if (lum > 0.62) {
    const k = 0.62 / lum
    return rgbToHex(r * k, g * k, b * k)
  }
  return hex
}

const darken = (hex: string, amt: number) => {
  const rgb = hexToRgb(hex)
  return rgb ? rgbToHex(rgb[0] * (1 - amt), rgb[1] * (1 - amt), rgb[2] * (1 - amt)) : hex
}

/* ---------- OKLCH：感知均匀的“明度 / 饱和度 / 色相” ---------- */

const toLin = (v: number) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const fromLin = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function toOklch(hex: string) {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  const [r, g, b] = rgb.map(toLin)
  const l = Math.cbrt(0.4122214708 * r + 0.5363069102 * g + 0.0514459511 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L, C: Math.hypot(A, B), H: Math.atan2(B, A) }
}

function oklchToHex(L: number, C: number, H: number) {
  // 超出 sRGB 时逐步降低饱和度，保证颜色可显示
  for (let c = C; c >= 0; c -= 0.005) {
    const A = c * Math.cos(H)
    const B = c * Math.sin(H)
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
    const rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ]
    if (rgb.every(v => v >= -0.0005 && v <= 1.0005)) return rgbToHex(...(rgb.map(fromLin) as [number, number, number]))
  }
  return DEFAULT
}

/**
 * 系统色只取“色相”，明度和饱和度对齐默认赤陶橙。
 * 安卓动态取色生成色板时会压低饱和度、按固定明度分阶，直接拿来用总会比 Claude 橙暗、发灰；
 * 这样处理后：系统主题是橙色时几乎就是默认赤陶橙，换成别的颜色也保持同样的明亮度与鲜艳度。
 */
export function harmonize(systemHex: string) {
  const sys = toOklch(systemHex)
  const base = toOklch(DEFAULT)
  if (!sys || !base) return DEFAULT
  // 系统色几乎是灰色（没有色相可言）：直接用默认色
  if (sys.C < 0.02) return DEFAULT
  return oklchToHex(base.L, base.C, sys.H)
}

/** 从色板里挑饱和度最高的那一阶，它的色相最准 */
function pickFromPalette(json: string): string | null {
  try {
    const tones = Object.values(JSON.parse(json) as Record<string, string>).filter(c => hexToRgb(c))
    if (!tones.length) return null
    return tones.reduce((a, b) => ((toOklch(b)?.C ?? 0) > (toOklch(a)?.C ?? 0) ? b : a))
  } catch {
    return null
  }
}

/** 读取系统强调色：安卓 12+ 动态取色 / Windows 个性化颜色 */
export async function systemAccent(): Promise<string | null> {
  try {
    const android = (window as any).ReadlyAndroid
    if (android?.getAccentPalette) {
      const c = pickFromPalette(android.getAccentPalette())
      if (c) return c
    }
    if (android?.getAccentColor) {
      const c = android.getAccentColor()
      if (c) return c
    }
    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core')
      const c = await invoke<string>('get_accent_color')
      if (c) return c
    }
  } catch (e) {
    console.warn('读取系统强调色失败', e)
  }
  return null
}

export async function resolveAccent(id: AccentId, custom?: string) {
  if (id === 'system') {
    const sys = await systemAccent()
    return sys ? harmonize(sys) : DEFAULT
  }
  // 自选颜色：太亮的压暗一点，保证按钮上的白字看得清
  if (id === 'custom') return custom && hexToRgb(custom) ? normalizeAccent(custom) : DEFAULT
  return ACCENTS.find(a => a.id === id)?.color ?? DEFAULT
}

export function applyAccent(color: string) {
  const root = document.documentElement.style
  root.setProperty('--brand', color)
  root.setProperty('--brand-ink', darken(color, 0.12))
}
