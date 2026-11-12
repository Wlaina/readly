/**
 * EPUB 内 XML 的容错修复。很多书经过各种工具处理后带着小毛病，
 * 浏览器的 XML 解析器很严格，一处错误就整本打不开；这里把常见毛病修掉。
 *
 * 只在严格解析失败时才动手（命名空间修正除外，它不影响解析但会让元数据丢失）。
 */

/** 解析失败时返回错误文本，成功返回 null */
function xmlError(text: string, type: DOMParserSupportedType = 'application/xml') {
  const doc = new DOMParser().parseFromString(text, type)
  const err = doc.getElementsByTagName('parsererror')[0]
  return err ? err.textContent ?? 'parse error' : null
}

/** XML 里没有定义、但书里常见的 HTML 实体 */
const HTML_ENTITIES: Record<string, number> = {
  nbsp: 160, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205,
  copy: 169, reg: 174, trade: 8482, deg: 176, middot: 183, times: 215, divide: 247,
  hellip: 8230, mdash: 8212, ndash: 8211, lsquo: 8216, rsquo: 8217, ldquo: 8220, rdquo: 8221,
  laquo: 171, raquo: 187, bull: 8226, prime: 8242, Prime: 8243, sect: 167, para: 182,
  yen: 165, euro: 8364, pound: 163, cent: 162, iexcl: 161, iquest: 191, shy: 173,
}
const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos'])

function fixMisplacedSlash(t: string) {
  // <item ... media-type="image/jpeg"/ properties="cover-image">  →  <item ... properties="cover-image"/>
  return t.replace(/"\s*\/\s+([\w:.-]+\s*=\s*"[^"<>]*"(?:\s+[\w:.-]+\s*=\s*"[^"<>]*")*)\s*\/?\s*>/g, '" $1/>')
}

function fixEntities(t: string) {
  return t.replace(/&(?:([a-zA-Z][\w.-]*);|(#\d+;|#x[0-9a-fA-F]+;))?/g, (m, name: string | undefined, num: string | undefined) => {
    if (num) return m
    if (name) {
      if (XML_ENTITIES.has(name)) return m
      const code = HTML_ENTITIES[name]
      return code ? `&#${code};` : `&amp;${name};`
    }
    return '&amp;' // 孤立的 &
  })
}

function fixAttrQuotes(t: string) {
  // 没加引号的属性值：<a href=foo.html>  →  <a href="foo.html">
  return t.replace(/(<[\w:.-]+(?:\s+[\w:.-]+\s*=\s*"[^"]*")*\s+[\w:.-]+\s*=\s*)([^\s"'<>/=]+)(?=[\s/>])/g, '$1"$2"')
}

/** OPF 里 Dublin Core 命名空间常见的写法错误（少了结尾斜杠），会导致书名作者读不出来 */
function fixNamespaces(t: string) {
  return t
    .replace(/(["'])http:\/\/purl\.org\/dc\/elements\/1\.1\1/g, '$1http://purl.org/dc/elements/1.1/$1')
    .replace(/(["'])http:\/\/purl\.org\/dc\/terms\1/g, '$1http://purl.org/dc/terms/$1')
}

const XML_FILE = /\.(opf|ncx|xml|xhtml|xht|html?|svg)$/i

/**
 * 修复 EPUB 内的文本文件；不是 XML 或本来就没问题的原样返回。
 */
export function repairXML(name: string, text: string): string {
  if (!XML_FILE.test(name)) return text
  let t = /\.opf$/i.test(name) ? fixNamespaces(text) : text
  const type: DOMParserSupportedType = /\.(x?html?|xht)$/i.test(name) ? 'application/xhtml+xml' : 'application/xml'
  if (!xmlError(t, type)) return t

  // 依次尝试各种修复，修好就停
  const steps = [fixMisplacedSlash, fixEntities, fixAttrQuotes]
  for (const step of steps) {
    t = step(t)
    if (!xmlError(t, type)) {
      console.info(`[Readly] 已自动修复 ${name}`)
      return t
    }
  }
  console.warn(`[Readly] ${name} 修复后仍无法解析`)
  return t
}
