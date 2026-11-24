/**
 * OneDrive 直连同步：通过 Microsoft Graph 读写你自己 OneDrive 里的文件，提供和 WebDAV 一样的接口（见 RemoteStore），
 * 同步逻辑（每台设备一个记录文件、按时间合并）完全不变，只是存的地方换成了 OneDrive。
 *
 * 登录：OAuth 2.0 授权码 + PKCE（公共客户端，没有密码）。在系统浏览器里登录，跳回 http://localhost:<临时端口>，
 * 由原生层接住（见 lib.rs 的 oauth_listen / oauth_wait）。换令牌也由原生层发（见 oauth_token）。
 * 拿到的 refresh token 加密保存在本机（和 WebDAV 密码一样），每次续期都会换新。
 *
 * 文件版本用 Graph 的 cTag（内容变了才会变），对应 WebDAV 的 ETag。
 */
import { isTauri } from './storage'
import { tr } from './i18n'
import { DavError, type DavEntry, type RemoteStore } from './webdav'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const SCOPES = 'Files.ReadWrite User.Read offline_access'
/** 4MB 以下直接上传，再大就用上传会话分片传 */
const SIMPLE_LIMIT = 4 * 1024 * 1024

type FetchFn = typeof fetch
let httpFetch: FetchFn | null = null
async function getFetch(): Promise<FetchFn> {
  if (!isTauri) return fetch.bind(window)
  if (!httpFetch) httpFetch = (await import('@tauri-apps/plugin-http')).fetch as FetchFn
  return httpFetch
}
const invoke = async <T,>(cmd: string, args?: Record<string, unknown>) => (await import('@tauri-apps/api/core')).invoke<T>(cmd, args)

/* ---------- 登录 ---------- */

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const randomString = (n = 48) => b64url(crypto.getRandomValues(new Uint8Array(n)))

async function tokenRequest(form: Record<string, string>) {
  const body = new URLSearchParams(form).toString()
  const [status, text] = await invoke<[number, string]>('oauth_token', { form: body })
  let data: Record<string, string> = {}
  try {
    data = JSON.parse(text)
  } catch {
    /* 下面按状态码报错 */
  }
  if (status !== 200 || !data.access_token) {
    const msg = data.error_description?.split('\r\n')[0] || data.error || `HTTP ${status}`
    // 授权被撤销 / 过期：需要重新登录
    if (data.error === 'invalid_grant') throw new DavError(401, tr('OneDrive 登录已失效，请重新登录'))
    throw new Error(msg)
  }
  return data as { access_token: string; refresh_token?: string; expires_in?: string | number }
}

export interface OneDriveLogin {
  refreshToken: string
  account: string
}

/**
 * 登录 OneDrive：打开系统浏览器，等你登录完跳回来，换成令牌。返回 refresh token 和账号名。
 * openUrl：打开网页的方法（电脑上用系统浏览器，安卓上交给 MainActivity）
 */
export async function loginOneDrive(clientId: string, openUrl: (url: string) => void | Promise<void>): Promise<OneDriveLogin> {
  if (!isTauri) throw new Error(tr('OneDrive 登录只能在 Readly 应用里进行'))
  const port = await invoke<number>('oauth_listen')
  const redirect = `http://localhost:${port}`
  const verifier = randomString(48)
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const state = randomString(16)
  const url = new URL('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize')
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirect,
    response_mode: 'query',
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString()
  await openUrl(url.toString())
  const query = new URLSearchParams(await invoke<string>('oauth_wait', { timeoutSecs: 600 }))
  if (query.get('error')) throw new Error(query.get('error_description') || query.get('error') || tr('登录失败'))
  if (query.get('state') !== state) throw new Error(tr('登录回调不匹配，请重试'))
  const code = query.get('code')
  if (!code) throw new Error(tr('登录失败'))
  const tok = await tokenRequest({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    scope: SCOPES,
  })
  if (!tok.refresh_token) throw new Error(tr('微软没有返回长期登录凭据，请确认应用注册里勾了 offline_access'))
  cache.set(clientId, { access: tok.access_token, exp: Date.now() + Number(tok.expires_in ?? 3600) * 1000, refresh: tok.refresh_token })
  // 账号名（显示用）
  let account = ''
  try {
    const f = await getFetch()
    const me = await f(`${GRAPH}/me?$select=displayName,userPrincipalName,mail`, { headers: { Authorization: `Bearer ${tok.access_token}` } })
    const j = await me.json()
    account = j.userPrincipalName || j.mail || j.displayName || ''
  } catch {
    /* 拿不到账号名不影响使用 */
  }
  return { refreshToken: tok.refresh_token, account }
}

export const cancelOneDriveLogin = () => invoke('oauth_cancel').catch(() => {})

/** 各个 OneDrive 实例共用的令牌缓存（同步引擎每次同步都会新建实例） */
const cache = new Map<string, { access: string; exp: number; refresh: string }>()

/* ---------- 读写 ---------- */

/** /Readly/devices/x.json.gz → Graph 的路径寻址 */
const encPath = (path: string) =>
  path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')

export class OneDrive implements RemoteStore {
  requests = 0
  private madeDirs = new Set<string>()

  constructor(
    private clientId: string,
    private refreshToken: string,
    /** 续期后拿到新的 refresh token：存起来 */
    private onRefresh: (refreshToken: string) => void,
  ) {}

  /** 拿一个有效的访问令牌（快过期时续期） */
  async token(): Promise<string> {
    const c = cache.get(this.clientId)
    if (c && c.exp - Date.now() > 120_000) return c.access
    const tok = await tokenRequest({
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: c?.refresh ?? this.refreshToken,
      scope: SCOPES,
    })
    const refresh = tok.refresh_token ?? c?.refresh ?? this.refreshToken
    cache.set(this.clientId, { access: tok.access_token, exp: Date.now() + Number(tok.expires_in ?? 3600) * 1000, refresh })
    if (refresh !== this.refreshToken) {
      this.refreshToken = refresh
      this.onRefresh(refresh)
    }
    return tok.access_token
  }

  /** 已有的访问令牌（没有或快过期时为空）：交给原生后台线程上传时用，那时来不及续期 */
  private cachedToken() {
    const c = cache.get(this.clientId)
    return c && c.exp - Date.now() > 60_000 ? c.access : ''
  }

  private itemUrl = (path: string) => (encPath(path) ? `${GRAPH}/me/drive/root:/${encPath(path)}` : `${GRAPH}/me/drive/root`)
  private contentUrl = (path: string) => `${this.itemUrl(path)}:/content`

  /** 发一个 Graph 请求；被限速（429/503）时按 Retry-After 等一下再试 */
  private async request(method: string, url: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
    const f = await getFetch()
    for (let attempt = 0; ; attempt++) {
      const token = await this.token()
      this.requests++
      const res = await f(url, { method, body: init.body, headers: { Authorization: `Bearer ${token}`, ...init.headers } })
      if ((res.status === 429 || res.status === 503) && attempt < 4) {
        const wait = Number(res.headers.get('Retry-After')) || 2 ** attempt * 2
        await new Promise(r => setTimeout(r, Math.min(60, wait) * 1000))
        continue
      }
      if (res.status === 401 && attempt === 0) {
        // 令牌被提前作废：清掉缓存续期一次
        const c = cache.get(this.clientId)
        if (c) cache.set(this.clientId, { ...c, exp: 0 })
        continue
      }
      if (res.status === 401) throw new DavError(401, tr('OneDrive 登录已失效，请重新登录'))
      return res
    }
  }

  async test() {
    const res = await this.request('GET', `${GRAPH}/me/drive?$select=id`)
    if (!res.ok) throw new DavError(res.status, `OneDrive ${res.status}`)
    return true
  }

  async propfind(path: string): Promise<DavEntry[] | null> {
    const out: DavEntry[] = []
    const base = path.replace(/\/+$/, '')
    let url: string | null = `${encPath(base) ? `${this.itemUrl(base)}:/children` : `${GRAPH}/me/drive/root/children`}?$top=1000&$select=id,name,size,cTag,eTag,lastModifiedDateTime,file,folder`
    while (url) {
      const res: Response = await this.request('GET', url)
      if (res.status === 404) return null
      if (!res.ok) throw new DavError(res.status, `OneDrive LIST ${res.status}`)
      const data = await res.json()
      for (const it of data.value ?? []) {
        out.push({
          path: `${base}/${it.name}`,
          name: it.name,
          isDir: !!it.folder,
          etag: it.cTag || it.eTag || '',
          lastModified: Date.parse(it.lastModifiedDateTime) || 0,
          size: Number(it.size) || 0,
          hash: it.file?.hashes?.quickXorHash,
        })
      }
      url = data['@odata.nextLink'] ?? null
    }
    return out
  }

  async mkcol(path: string) {
    const parts = path.split('/').filter(Boolean)
    const name = parts.pop()
    if (!name) return
    const parent = parts.length ? `${this.itemUrl('/' + parts.join('/'))}:/children` : `${GRAPH}/me/drive/root/children`
    const res = await this.request('POST', parent, {
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      headers: { 'Content-Type': 'application/json' },
    })
    // 409：已经有了
    if (!res.ok && res.status !== 409) throw new DavError(res.status, `OneDrive MKDIR ${path} ${res.status}`)
  }

  async ensureDir(path: string) {
    let cur = ''
    for (const p of path.split('/').filter(Boolean)) {
      cur += '/' + p
      if (this.madeDirs.has(cur)) continue
      await this.mkcol(cur)
      this.madeDirs.add(cur)
    }
  }

  /** 一个文件的信息：cTag、大小、quickXorHash、预授权的下载地址；不存在为 null */
  async item(path: string): Promise<{ cTag: string; size: number; quickXor: string; downloadUrl: string } | null> {
    const res = await this.request('GET', this.itemUrl(path))
    if (res.status === 404) return null
    if (!res.ok) throw new DavError(res.status, `OneDrive GET ${path} ${res.status}`)
    const it = await res.json()
    return {
      cTag: it.cTag ?? '',
      size: Number(it.size) || 0,
      quickXor: it.file?.hashes?.quickXorHash ?? '',
      downloadUrl: it['@microsoft.graph.downloadUrl'] ?? '',
    }
  }

  async getBytes(path: string): Promise<Uint8Array | null> {
    const res = await this.request('GET', this.contentUrl(path))
    if (res.status === 404) return null
    if (!res.ok) throw new DavError(res.status, `OneDrive GET ${path} ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  /** 条件下载：cTag 没变就不下载 */
  async getIfChanged(path: string, etag?: string) {
    const it = await this.item(path)
    if (!it) return null
    if (etag && it.cTag === etag) return { notModified: true as const }
    const bytes = await this.getBytes(path)
    if (!bytes) return null
    return { notModified: false as const, bytes, etag: it.cTag }
  }

  async getBytesProgress(path: string, onProgress: (loaded: number, total: number) => void): Promise<Uint8Array | null> {
    const res = await this.request('GET', this.contentUrl(path))
    if (res.status === 404) return null
    if (!res.ok) throw new DavError(res.status, `OneDrive GET ${path} ${res.status}`)
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

  /** 上传；返回新的 cTag */
  async put(path: string, data: Uint8Array | string, contentType = 'application/octet-stream') {
    const body = typeof data === 'string' ? new TextEncoder().encode(data) : data
    if (body.byteLength > SIMPLE_LIMIT) return this.putLarge(path, body)
    const res = await this.request('PUT', this.contentUrl(path), { body: body as BodyInit, headers: { 'Content-Type': contentType } })
    if (!res.ok) throw new DavError(res.status, `OneDrive PUT ${path} ${res.status}`)
    const it = await res.json().catch(() => ({}))
    return (it.cTag as string) ?? ''
  }

  /** 新建上传会话（覆盖同名文件），返回分片上传地址 */
  async uploadSession(path: string): Promise<string> {
    const res = await this.request('POST', `${this.itemUrl(path)}:/createUploadSession`, {
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) throw new DavError(res.status, `OneDrive SESSION ${path} ${res.status}`)
    const { uploadUrl } = await res.json()
    if (!uploadUrl) throw new Error(tr('OneDrive 没有返回上传地址'))
    return uploadUrl
  }

  /** 网页里分片上传（4MB 以上的设备记录文件等；书籍文件走原生层，见 transferFile） */
  private async putLarge(path: string, body: Uint8Array) {
    const url = await this.uploadSession(path)
    const f = await getFetch()
    const CHUNK = 320 * 1024 * 16
    let last: Record<string, string> = {}
    for (let off = 0; off < body.byteLength; off += CHUNK) {
      const end = Math.min(body.byteLength, off + CHUNK)
      const res = await f(url, {
        method: 'PUT',
        body: body.subarray(off, end) as BodyInit,
        headers: { 'Content-Range': `bytes ${off}-${end - 1}/${body.byteLength}` },
      })
      if (!res.ok) throw new DavError(res.status, `OneDrive PUT ${path} ${res.status}`)
      if (end === body.byteLength) last = await res.json().catch(() => ({}))
    }
    return last.cTag ?? ''
  }

  putJSON(path: string, data: unknown) {
    return this.put(path, JSON.stringify(data), 'application/json')
  }

  async remove(path: string) {
    const res = await this.request('DELETE', this.itemUrl(path))
    if (!res.ok && res.status !== 404) throw new DavError(res.status, `OneDrive DELETE ${path} ${res.status}`)
  }

  /** 交给原生后台线程上传设备记录时用（安卓退到后台时）：地址和当前的访问令牌 */
  target(path: string) {
    const t = this.cachedToken()
    return { url: this.contentUrl(path), auth: t ? `Bearer ${t}` : '' }
  }

  /**
   * 书籍文件：原生层直接从磁盘上传（建好上传会话后分片传）/ 边下边写进磁盘。
   * file 是应用数据目录里的相对路径
   */
  async transferFile(kind: 'upload' | 'download', path: string, file: string, onProgress: (done: number, total: number) => void) {
    const { listen } = await import('@tauri-apps/api/event')
    const task = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const stop = await listen<[string, number, number]>('dav-progress', e => e.payload[0] === task && onProgress(e.payload[1], e.payload[2]))
    this.requests++
    try {
      if (kind === 'upload') {
        const uploadUrl = await this.uploadSession(path)
        const text = await invoke<string>('od_upload', { uploadUrl, file, task })
        try {
          return (JSON.parse(text).cTag as string) ?? ''
        } catch {
          return ''
        }
      }
      return await invoke<number>('dav_download', { url: this.contentUrl(path), auth: `Bearer ${await this.token()}`, file, task })
    } catch (e) {
      if (e instanceof DavError) throw e
      const status = Number(String(e).match(/^HTTP (\d+)/)?.[1])
      throw status ? new DavError(status, `OneDrive ${kind} ${path} ${status}`) : new Error(String(e))
    } finally {
      stop()
    }
  }
}
