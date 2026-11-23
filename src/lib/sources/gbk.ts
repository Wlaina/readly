/**
 * GBK 网址编码（轻小说文库的搜索参数要用 GBK）。
 * 浏览器只内置 GBK 解码，所以第一次用时把所有双字节编码解一遍，反查出“字 → 字节”的表。
 */
let table: Map<string, [number, number]> | null = null

function build() {
  const dec = new TextDecoder('gbk')
  const map = new Map<string, [number, number]>()
  const buf = new Uint8Array(2)
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (lo === 0x7f) continue
      buf[0] = hi
      buf[1] = lo
      const ch = dec.decode(buf)
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [hi, lo])
    }
  }
  return map
}

const hex = (n: number) => '%' + n.toString(16).toUpperCase().padStart(2, '0')

/** 相当于 URLEncoder.encode(s, "GBK")；GBK 里没有的字跳过 */
export function encodeGbk(s: string) {
  table ??= build()
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0)!
    if (code < 0x80) out += /[A-Za-z0-9\-_.*]/.test(ch) ? ch : ch === ' ' ? '+' : hex(code)
    else {
      const b = table.get(ch)
      if (b) out += hex(b[0]) + hex(b[1])
    }
  }
  return out
}
