/**
 * 界面语言：中文 / English。
 *
 * 用法：tr('书架') → 中文原样返回，英文模式查 EN 词典；没有译文时回退中文。
 * 带变量：tr('已移除 {n} 本书', { n: 3 })。英文译文可以是函数，用来处理单复数。
 * 切换语言时 App 会整体重新挂载，所以在渲染时调用 tr() 即可，无需订阅。
 */
import { EN } from './i18n-en'

export type Lang = 'zh' | 'en'
type Vars = Record<string, string | number>

let lang: Lang = 'zh'

export function setLang(l: Lang) {
  lang = l
  if (typeof document !== 'undefined') document.documentElement.lang = l === 'en' ? 'en' : 'zh-CN'
}

export const getLang = () => lang
export const isEn = () => lang === 'en'

export function tr(zh: string, vars?: Vars): string {
  let s: string = zh
  if (lang === 'en') {
    const e = EN[zh]
    if (typeof e === 'function') return e(vars ?? {})
    if (e != null) s = e
  }
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : s
}

/** 英文复数小工具：plural(3, 'book') → "3 books" */
export const plural = (n: number | string, word: string, many = `${word}s`) => `${n} ${Number(n) === 1 ? word : many}`
