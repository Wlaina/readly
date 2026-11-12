import { isTauri } from './storage'
import { tr } from './i18n'

export interface WebDAVConfig {
  url: string
  username: string
  password: string
  root: string
}

export interface DavEntry {
  path: string
  name: string
  isDir: boolean
  etag: string
  lastModified: number
  size: number
}

type FetchFn = typeof fetch
let tauriFetch: FetchFn | null = null
async function getFetch(): Promise<FetchFn> {
  if (!isTauri) return fetch.bind(window)
  if (!tauriFetch) tauriFetch = (await import('@tauri-apps/plugin-http')).fetch as FetchFn
  return tauriFetch
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

export class DavError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export class WebDAV {
  private base: string
  private auth: string
  constructor(cfg: WebDAVConfig) {
    this.base = cfg.url.replace(/\/+$/, '')
    this.auth = 'Basic ' + b64(`${cfg.username}:${cfg.password}`)
  }

  private url(path: string) {
    const clean = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    return `${this.base}/${clean}${path.endsWith('/') && clean ? '/' : ''}`
  }

  /** 某个远端路径的完整地址与认证头（交给原生后台线程上传时用） */
  target(path: string) {
    return { url: this.url(path), auth: this.auth }
  }

  /** 本实例发出的请求数，用于同步日志 */
  requests = 0

  private async request(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
    const f = await getFetch()
    this.requests++
    const res = await f(this.url(path), {
      method,
      body: init.body,
      headers: { Authorization: this.auth, ...init.headers },
    })
    return res
  }

  async propfind(path: string): Promise<DavEntry[] | null> {
    const body = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>`
    const res = await this.request('PROPFIND', path.endsWith('/') ? path : path + '/', {
      body,
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    })
    if (res.status === 404) return null
    if (res.status === 401) throw new DavError(401, tr('认证失败，请检查账号与（应用）密码'))
    if (!res.ok && res.status !== 207) throw new DavError(res.status, `PROPFIND ${res.status}`)
    const xml = new DOMParser().parseFromString(await res.text(), 'application/xml')
    const NS = 'DAV:'
    const text = (el: Element, tag: string) => el.getElementsByTagNameNS(NS, tag)[0]?.textContent ?? ''
    const selfPath = new URL(this.url(path.endsWith('/') ? path : path + '/')).pathname.replace(/\/+$/, '')
    const out: DavEntry[] = []
    for (const r of Array.from(xml.getElementsByTagNameNS(NS, 'response'))) {
      const href = decodeURIComponent(new URL(text(r, 'href'), this.base).pathname).replace(/\/+$/, '')
      if (href === decodeURIComponent(selfPath)) continue
      const lastModified = Date.parse(text(r, 'getlastmodified')) || 0
      const size = Number(text(r, 'getcontentlength')) || 0
      const etag = text(r, 'getetag').replace(/^W\//, '').replace(/"/g, '')
      out.push({
        path: href,
        name: href.split('/').pop() ?? '',
        isDir: r.getElementsByTagNameNS(NS, 'collection').length > 0,
        // 部分服务（如 Koofr）不返回 ETag，用修改时间+大小代替
        etag: etag || (lastModified ? `${lastModified}-${size}` : ''),
        lastModified,
        size,
      })
    }
    return out
  }

  async mkcol(path: string) {
    const res = await this.request('MKCOL', path.endsWith('/') ? path : path + '/')
    // 201 新建；405 已存在
    if (!res.ok && res.status !== 405 && res.status !== 301) throw new DavError(res.status, `MKCOL ${path} ${res.status}`)
  }

  async ensureDir(path: string) {
    const parts = path.split('/').filter(Boolean)
    let cur = ''
    for (const p of parts) {
      cur += '/' + p
      const exists = await this.propfind(cur).catch(e => {
        if (e instanceof DavError && e.status === 401) throw e
        return null
      })
      if (!exists) await this.mkcol(cur)
    }
  }

  async getBytes(path: string): Promise<Uint8Array | null> {
    const res = await this.request('GET', path)
    if (res.status === 404) return null
    if (!res.ok) throw new DavError(res.status, `GET ${path} ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  /**
   * 条件下载：带上已知 ETag，没变化时服务器回 304，几乎不耗流量。
   * 返回 null 表示文件不存在；notModified 表示没变化。
   */
  async getIfChanged(path: string, etag?: string): Promise<{ notModified: true } | { notModified: false; bytes: Uint8Array; etag: string } | null> {
    // 伪造的 ETag（修改时间-大小）不能用于条件请求
    const real = etag && !/^\d+-\d+$/.test(etag)
    const res = await this.request('GET', path, real ? { headers: { 'If-None-Match': `"${etag}"` } } : {})
    if (res.status === 304) return { notModified: true }
    if (res.status === 404) return null
    if (!res.ok) throw new DavError(res.status, `GET ${path} ${res.status}`)
    const newTag = (res.headers.get('ETag') ?? '').replace(/^W\//, '').replace(/"/g, '')
    return { notModified: false, bytes: new Uint8Array(await res.arrayBuffer()), etag: newTag }
  }

  /** 带进度的下载（书籍文件用）；服务器没给长度时 total 为 0 */
  async getBytesProgress(path: string, onProgress: (loaded: number, total: number) => void): Promise<Uint8Array | null> {
    const res = await this.request('GET', path)
    if (res.status === 404) return null
    if (!res.ok) throw new DavError(res.status, `GET ${path} ${res.status}`)
    const total = Number(res.headers.get('Content-Length')) || 0
    const reader = res.body?.getReader()
    if (!reader) {
      const buf = new Uint8Array(await res.arrayBuffer())
      onProgress(buf.byteLength, buf.byteLength)
      return buf
    }
    const chunks: Uint8Array[] = []
    let loaded = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.byteLength
      onProgress(loaded, total)
    }
    const out = new Uint8Array(loaded)
    let off = 0
    for (const c of chunks) {
      out.set(c, off)
      off += c.byteLength
    }
    return out
  }

  async getJSON<T>(path: string): Promise<T | null> {
    const bytes = await this.getBytes(path)
    return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as T) : null
  }

  async put(path: string, data: Uint8Array | string, contentType = 'application/octet-stream') {
    const body = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const res = await this.request('PUT', path, { body: body as BodyInit, headers: { 'Content-Type': contentType } })
    if (!res.ok) throw new DavError(res.status, `PUT ${path} ${res.status}`)
    return (res.headers.get('ETag') ?? '').replace(/^W\//, '').replace(/"/g, '')
  }

  putJSON(path: string, data: unknown) {
    return this.put(path, JSON.stringify(data), 'application/json; charset=utf-8')
  }

  async remove(path: string) {
    const res = await this.request('DELETE', path)
    if (!res.ok && res.status !== 404) throw new DavError(res.status, `DELETE ${path} ${res.status}`)
  }
}
