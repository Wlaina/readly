/**
 * 模糊搜索（书架用）：
 * - 忽略大小写、全角半角、空格和标点
 * - 多个关键词用空格分开，全部命中才算（顺序不限）
 * - 关键词的字不必挨着（“白少女复仇”能找到《白发红瞳少女要复仇…》）
 * - 支持拼音首字母（“bfht”能找到《白发红瞳…》）
 * 结果按匹配程度排序：连续命中 > 跳字命中 > 拼音首字母。
 */

/** 归一化：NFKC（全角→半角）、小写、去掉空白与标点 */
export const normalize = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')

/* ---------- 拼音首字母：用 ICU 的拼音排序找到每个字落在哪个声母区间，不需要字典 ---------- */
const BOUNDARY = '阿八嚓哒妸发旮哈讥咔垃痳拏噢妑七呥扨它穵夕丫帀'
const LETTERS = 'abcdefghjklmnopqrstwxyz'
let pinyin: Intl.Collator | null | undefined
const getCollator = () => {
  if (pinyin !== undefined) return pinyin
  try {
    const c = new Intl.Collator('zh-CN-u-co-pinyin')
    // 环境不带拼音排序数据时这两个字的顺序会不对，那就不提供拼音搜索
    pinyin = c.compare('阿', '帀') < 0 && c.compare('八', '发') < 0 ? c : null
  } catch {
    pinyin = null
  }
  return pinyin
}
const initialCache = new Map<string, string>()
function initialOf(ch: string): string {
  if (ch < '一' || ch > '鿿') return ch
  const hit = initialCache.get(ch)
  if (hit !== undefined) return hit
  const c = getCollator()
  let out = ''
  if (c) {
    for (let i = BOUNDARY.length - 1; i >= 0; i--) {
      if (c.compare(ch, BOUNDARY[i]) >= 0) {
        out = LETTERS[i]
        break
      }
    }
  }
  initialCache.set(ch, out)
  return out
}
/** 一段文字的拼音首字母串（已归一化的文字） */
export const initials = (norm: string) => Array.from(norm, initialOf).join('')

/** 子序列匹配：needle 的每个字按顺序出现在 hay 里。返回跨度（越小越紧凑），不匹配返回 -1 */
function subsequenceSpan(hay: string, needle: string): number {
  let best = -1
  for (let start = hay.indexOf(needle[0]); start !== -1; start = hay.indexOf(needle[0], start + 1)) {
    let i = start
    let ok = true
    for (let k = 1; k < needle.length; k++) {
      i = hay.indexOf(needle[k], i + 1)
      if (i === -1) {
        ok = false
        break
      }
    }
    if (!ok) break // 从更靠后的位置开始只会更难匹配
    const span = i - start + 1
    if (best === -1 || span < best) best = span
    if (span === needle.length) break
  }
  return best
}

export interface Searchable {
  title: string
  author: string
  /** 标题的拼音首字母 */
  titleInitials: string
}

const prepared = new Map<string, Searchable>()
/** 预处理书名与作者（按原文缓存，书多时不用每次按键都重新算） */
export function prepare(title: string, author: string): Searchable {
  const key = `${title}\u0000${author}`
  let p = prepared.get(key)
  if (!p) {
    const t = normalize(title)
    p = { title: t, author: normalize(author), titleInitials: initials(t) }
    if (prepared.size > 5000) prepared.clear()
    prepared.set(key, p)
  }
  return p
}

/** 单个关键词的得分；不匹配返回 0 */
function scoreToken(s: Searchable, tok: string): number {
  const at = s.title.indexOf(tok)
  if (at !== -1) return 1000 - Math.min(at, 200) + (at === 0 ? 100 : 0) + (tok.length === s.title.length ? 200 : 0)
  if (s.author.includes(tok)) return 700
  if (tok.length >= 2) {
    const span = subsequenceSpan(s.title, tok)
    // 跨度太大的（字隔得很远）多半是巧合，不算
    if (span !== -1 && span <= tok.length * 3 + 2) return 500 - Math.min(span, 100)
    // 拼音首字母：只对纯字母数字的关键词尝试
    if (/^[a-z0-9]+$/.test(tok)) {
      const pi = s.titleInitials.indexOf(tok)
      if (pi !== -1) return 300 - Math.min(pi, 100)
    }
  }
  return 0
}

/** 整个查询的得分：每个关键词都要命中；不匹配返回 0 */
export function fuzzyScore(s: Searchable, query: string): number {
  const tokens = query.split(/\s+/).map(normalize).filter(Boolean)
  if (!tokens.length) return 0
  let total = 0
  for (const t of tokens) {
    const sc = scoreToken(s, t)
    if (!sc) return 0
    total += sc
  }
  return total / tokens.length
}

/* ---------- 书内搜索：把你输入的文字变成一个宽松的正则 ---------- */

const escapeRe = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
/** 一个字符的各种写法：半角与全角算同一个字（大小写由正则的 i 标志处理） */
function charAlt(ch: string): string {
  const code = ch.codePointAt(0)!
  if (code >= 0x21 && code <= 0x7e) return `[${escapeRe(ch)}${String.fromCodePoint(code + 0xfee0)}]`
  return escapeRe(ch)
}
/** 字与字之间允许夹着的东西：空白、标点、符号（“他说你好”能找到“他说：‘你好’”） */
const GAP = '[\\s\\p{P}\\p{S}]{0,6}'

/**
 * 书内模糊搜索用的正则（交给渲染引擎的 regex 模式）：
 * - 不区分大小写、全角半角
 * - 字之间夹着标点、空格、换行也能匹配
 * - 用空格分开多个关键词：它们在 60 个字以内先后出现（顺序不限，最多两个词时）就算命中
 * 返回 null 表示没有可搜的内容。
 */
export function buildSearchRegex(input: string): string | null {
  const terms = input
    .normalize('NFKC')
    .split(/\s+/)
    .map(t => Array.from(t).filter(ch => /[\p{L}\p{N}]/u.test(ch)))
    .filter(t => t.length)
    .slice(0, 5)
  if (!terms.length) return null
  const pat = terms.map(t => t.map(charAlt).join(GAP))
  if (pat.length === 1) return pat[0]
  const near = '[\\s\\S]{0,60}?'
  if (pat.length === 2) return `(?:${pat[0]}${near}${pat[1]}|${pat[1]}${near}${pat[0]})`
  return pat.join(near)
}

/** 按模糊匹配过滤并排序（同分保持原顺序） */
export function fuzzyFilter<T>(items: T[], query: string, pick: (item: T) => { title: string; author: string }): T[] {
  if (!query.trim()) return items
  const scored: { item: T; score: number; i: number }[] = []
  items.forEach((item, i) => {
    const { title, author } = pick(item)
    const score = fuzzyScore(prepare(title, author), query)
    if (score > 0) scored.push({ item, score, i })
  })
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map(x => x.item)
}
