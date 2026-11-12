/**
 * WebDAV 多端同步（v2：每台设备一个文件）
 *
 * 远端目录结构（root 默认为 /Readly）：
 *   /Readly/*.epub|*.txt               你手动放进来的书，同步时自动导入（原文件不动）
 *   /Readly/devices/<设备ID>.json.gz   每台设备所知道的全部书籍记录（进度、书签、阅读时长…），gzip 压缩
 *   /Readly/files/<hash>.<ext>         Readly 上传的书籍文件
 *   /Readly/settings-desktop.json / settings-mobile.json  外观与行为设置：电脑与手机分开
 *   /Readly/books/<hash>.json          v1 旧格式，只在首次升级时读取一次，不再写入
 *
 * 为什么快：不管书架上有多少本书，一次同步只有 2~4 个并行请求；
 * 其他设备的文件用 ETag 条件请求，没变化时服务器回 304。
 *
 * 冲突策略：进度取最新时间戳；书签按 id 合并、各自取最新；阅读时长按设备取较大值；
 * 元数据（含删除状态）按 metaUpdatedAt 取最新。localOnly（仅本机）的书不参与同步。
 */
import type { Annotation, BookRecord, Bookmark, Category } from './types'
import type { Settings } from './settings'
import { WebDAV, type DavEntry, type WebDAVConfig } from './webdav'
import { deviceClass, getDevice } from './device'
import { endTask, startTask, updateTask } from './tasks'
import { tr } from './i18n'

export interface SyncConfig extends WebDAVConfig {
  enabled: boolean
  syncFiles: boolean
  syncSettings: boolean
  /** 自动同步间隔（分钟），0 表示只在启动/切回时同步 */
  interval: number
  /** 自动导入手动放入云端根目录的书 */
  scanRoot: boolean
}

export const DEFAULT_SYNC: SyncConfig = {
  enabled: false,
  url: 'https://dav.jianguoyun.com/dav/',
  username: '',
  password: '',
  root: '/Readly',
  syncFiles: true,
  syncSettings: true,
  interval: 10,
  scanRoot: true,
}

/** 远端存储的书籍记录（去掉本机专属字段） */
export type RemoteBook = Omit<
  BookRecord,
  'hasFile' | 'hasCover' | 'syncedAt' | 'localOnly' | 'coverChecked' | 'coverRev' | 'fileRevLocal' | 'pendingUpload' | 'folderRef'
>

export const toRemote = ({
  hasFile: _a,
  hasCover: _b,
  syncedAt: _c,
  localOnly: _d,
  coverChecked: _e,
  fileRevLocal: _f,
  pendingUpload: _g,
  folderRef: _h,
  coverRev: _i,
  ...rest
}: BookRecord): RemoteBook => rest

export interface SyncMemo {
  /** 远端文件名（如 devices/xxx.json.gz）-> ETag */
  etags: Record<string, string>
  /** 已扫描过的云端手动放入文件：路径 -> etag */
  scanned: Record<string, string>
  /** 上次上传的本机设备文件摘要；没变化就不上传 */
  pushed?: string
  /** 已从 v1 books/*.json 迁移过的根目录 */
  migrated?: string
  /** 已确认存在的目录（避免每次都检查） */
  dirs?: string
  /** 上次看到的云端设置时间戳 */
  settingsAt?: number
}

interface DeviceFile {
  v: 2
  device: { id: string; name: string; class: string }
  updatedAt: number
  books: Record<string, RemoteBook>
  /** 书架分类（0.6.0 起；旧版本会忽略这个字段） */
  categories?: Category[]
}

const BOOK_EXT = /\.(epub|txt)$/i

/* ---------- 合并规则 ---------- */

function mergeBookmarks(a: Bookmark[], b: Bookmark[]) {
  const map = new Map<string, Bookmark>()
  for (const bm of [...a, ...b]) {
    const cur = map.get(bm.id)
    if (!cur || bm.updatedAt > cur.updatedAt) map.set(bm.id, bm)
  }
  return [...map.values()].sort((x, y) => x.fraction - y.fraction)
}

/** 高亮与笔记：与书签同样按 id 合并，较新的修改胜出 */
function mergeAnnotations(a: Annotation[] = [], b: Annotation[] = []) {
  const map = new Map<string, Annotation>()
  for (const x of [...a, ...b]) {
    const cur = map.get(x.id)
    if (!cur || x.updatedAt > cur.updatedAt) map.set(x.id, x)
  }
  return [...map.values()].sort((x, y) => x.fraction - y.fraction)
}

/** 阅读时长：每台设备的计数只增不减，按设备取较大者，不会重复累计 */
function mergeReadStats(a: BookRecord['readStats'], b: BookRecord['readStats']) {
  if (!a) return b
  if (!b) return a
  const out = { ...a }
  for (const [id, s] of Object.entries(b)) if (!out[id] || s.ms > out[id].ms) out[id] = s
  return out
}

/**
 * 分类列表：按 id 合并，较新的修改胜出（删除也是一次修改）。
 * 返回合并结果；与本机完全一致时返回 null，调用方就不用写盘。
 */
export function mergeCategories(local: Category[], remote: Category[]): Category[] | null {
  const map = new Map(local.map(c => [c.id, c]))
  let changed = false
  for (const r of remote) {
    if (!r?.id || typeof r.name !== 'string') continue
    const cur = map.get(r.id)
    if (!cur || (r.updatedAt ?? 0) > (cur.updatedAt ?? 0)) {
      map.set(r.id, r)
      changed = true
    }
  }
  return changed ? [...map.values()].sort((a, b) => a.order - b.order || a.updatedAt - b.updatedAt) : null
}

export function mergeBook(local: BookRecord | undefined, remote: RemoteBook): BookRecord {
  if (!local) return { ...remote, bookmarks: remote.bookmarks ?? [], hasFile: false, hasCover: false }
  // 分类归属整体取较新的一方（旧版本设备传来的记录没有 catsAt，永远不会覆盖本机的分类）
  const catSrc = (remote.catsAt ?? 0) > (local.catsAt ?? 0) ? remote : local
  const metaSrc = remote.metaUpdatedAt > local.metaUpdatedAt ? remote : local
  const progress =
    !local.progress || (remote.progress && remote.progress.updatedAt > local.progress.updatedAt)
      ? (remote.progress ?? local.progress)
      : local.progress
  return {
    ...local,
    title: metaSrc.title,
    author: metaSrc.author,
    deletedAt: metaSrc.deletedAt,
    metaUpdatedAt: metaSrc.metaUpdatedAt,
    remotePath: local.remotePath ?? remote.remotePath,
    fileRev: Math.max(local.fileRev ?? 0, remote.fileRev ?? 0) || undefined,
    progress,
    lastReadAt: Math.max(local.lastReadAt ?? 0, remote.lastReadAt ?? 0) || undefined,
    categories: catSrc.categories,
    catsAt: catSrc.catsAt,
    bookmarks: mergeBookmarks(local.bookmarks, remote.bookmarks ?? []),
    annotations: mergeAnnotations(local.annotations, remote.annotations),
    // 清除统计：取较晚的清除时间；清除时间较早的一方，其统计视为作废
    ...(() => {
      const cleared = Math.max(local.statsClearedAt ?? 0, remote.statsClearedAt ?? 0)
      const l = (local.statsClearedAt ?? 0) >= cleared ? local.readStats : undefined
      const r = (remote.statsClearedAt ?? 0) >= cleared ? remote.readStats : undefined
      return { readStats: mergeReadStats(l, r), statsClearedAt: cleared || undefined }
    })(),
    addedAt: Math.min(local.addedAt, remote.addedAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  }
}

/** 判断合并是否真的带来了变化（只看会被合并的字段，避免键顺序造成误判） */
function fingerprint(b: BookRecord | RemoteBook) {
  return JSON.stringify([
    b.title,
    b.author,
    b.metaUpdatedAt,
    b.deletedAt ?? 0,
    b.remotePath ?? '',
    b.statsClearedAt ?? 0,
    b.fileRev ?? 0,
    b.catsAt ?? 0,
    b.progress?.cfi ?? '',
    b.progress?.updatedAt ?? 0,
    (b.bookmarks ?? []).map(m => `${m.id}:${m.updatedAt}`).join(','),
    (b.annotations ?? []).map(m => `${m.id}:${m.updatedAt}`).join(','),
    Object.entries(b.readStats ?? {})
      .map(([id, s]) => `${id}:${s.ms}`)
      .sort()
      .join(','),
  ])
}

/* ---------- 工具 ---------- */

/** FNV-1a，用来判断设备文件内容是否变化 */
function digest(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16)}-${s.length}`
}

async function gzip(text: string) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function gunzipText(bytes: Uint8Array) {
  // 有些服务器会自动解压（Content-Encoding），这里按魔数判断
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes)
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

/** 并发池：最多 n 个请求同时进行 */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0
  const worker = async () => {
    while (i < items.length) await fn(items[i++])
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
}

export interface SyncHooks {
  getLibrary: () => BookRecord[]
  saveBooks: (books: BookRecord[]) => void
  readBookFile: (rec: BookRecord) => Promise<Uint8Array | null>
  writeBookFile: (rec: BookRecord, bytes: Uint8Array) => Promise<void>
  /** 导入云端手动放入的书，返回生成的记录 */
  importRemoteFile: (name: string, bytes: Uint8Array, remotePath: string) => Promise<BookRecord | null>
  getSettings: () => Settings
  applySettings: (s: Settings) => void
  getCategories: () => Category[]
  saveCategories: (list: Category[]) => void
  log: (msg: string) => void
}

export class SyncEngine {
  private dav: WebDAV
  private root: string
  constructor(
    private cfg: SyncConfig,
    private hooks: SyncHooks,
    private memo: SyncMemo,
  ) {
    this.dav = new WebDAV(cfg)
    this.root = '/' + cfg.root.split('/').filter(Boolean).join('/')
  }

  private get ownName() {
    return `${getDevice().id}.json.gz`
  }
  private filePath = (rec: BookRecord) => rec.remotePath ?? `${this.root}/files/${rec.hash}.${rec.format}`
  private settingsName = `settings-${deviceClass}.json`

  async test() {
    await this.dav.ensureDir(this.root)
    return true
  }

  private async ensureDirs(force = false) {
    const key = `${this.cfg.url}|${this.root}|${this.cfg.syncFiles}`
    if (!force && this.memo.dirs === key) return
    await this.dav.ensureDir(`${this.root}/devices`)
    if (this.cfg.syncFiles) await this.dav.ensureDir(`${this.root}/files`)
    this.memo.dirs = key
  }

  /** 把其他设备的记录合并进本地书架（同步执行，不会和翻页保存交错），返回有变化的书本数 */
  private mergeRecords(records: RemoteBook[]) {
    const lib = new Map(this.hooks.getLibrary().map(b => [b.hash, b]))
    const changed = new Map<string, BookRecord>()
    for (const r of records) {
      if (!r?.hash) continue
      const local = changed.get(r.hash) ?? lib.get(r.hash)
      if (local?.localOnly) continue
      const merged = mergeBook(local, r)
      if (!local || fingerprint(merged) !== fingerprint(local)) changed.set(r.hash, merged)
    }
    if (changed.size) this.hooks.saveBooks([...changed.values()])
    return changed.size
  }

  private parseDevice(text: string): DeviceFile | null {
    try {
      const f = JSON.parse(text) as DeviceFile
      return f?.v === 2 && f.books ? f : null
    } catch {
      return null
    }
  }

  /** 把其他设备的分类合并进本机 */
  private mergeCats(files: (DeviceFile | null)[]) {
    const remote = files.flatMap(f => (Array.isArray(f?.categories) ? f!.categories! : []))
    if (!remote.length) return
    const merged = mergeCategories(this.hooks.getCategories(), remote)
    if (merged) this.hooks.saveCategories(merged)
  }

  /** 构造本机的设备文件 */
  private buildOwn() {
    const books: Record<string, RemoteBook> = {}
    for (const b of [...this.hooks.getLibrary()].sort((x, y) => (x.hash < y.hash ? -1 : 1)))
      if (!b.localOnly) books[b.hash] = toRemote(b)
    const categories = [...this.hooks.getCategories()].sort((x, y) => (x.id < y.id ? -1 : 1))
    const body = JSON.stringify(books) + (categories.length ? JSON.stringify(categories) : '')
    const dev = getDevice()
    const file: DeviceFile = { v: 2, device: { id: dev.id, name: dev.name, class: deviceClass }, updatedAt: Date.now(), books, categories }
    return { text: JSON.stringify(file), sum: digest(body) }
  }

  /**
   * 交给原生后台线程上传时用：本机设备文件的地址、认证头与内容（未压缩，由原生端 gzip）。
   * 内容和上次上传的一样时返回 null。
   */
  ownUpload(): { url: string; auth: string; text: string } | null {
    const { text, sum } = this.buildOwn()
    if (this.memo.pushed === sum) return null
    return { ...this.dav.target(`${this.root}/devices/${this.ownName}`), text }
  }

  /** 上传本机设备文件；内容没变就跳过。返回是否上传 */
  async push(force = false): Promise<boolean> {
    const { text, sum } = this.buildOwn()
    if (!force && this.memo.pushed === sum) return false
    const bytes = await gzip(text)
    const path = `${this.root}/devices/${this.ownName}`
    try {
      await this.dav.put(path, bytes, 'application/gzip')
    } catch (e) {
      // 认证失败直接报错；其他情况可能是目录被删了：重建后再试一次
      if ((e as { status?: number }).status === 401) throw e
      await this.ensureDirs(true)
      await this.dav.put(path, bytes, 'application/gzip')
    }
    this.memo.pushed = sum
    return true
  }

  /**
   * 快速拉取：并行条件请求其他设备的文件（进书、切回前台时用）。
   * 第一次还不知道有哪些设备时，先列一次目录。
   */
  async pull(): Promise<number> {
    let names = Object.keys(this.memo.etags)
      .filter(k => k.startsWith('devices/'))
      .map(k => k.slice(8))
      .filter(n => n !== this.ownName)
    if (!names.length) {
      const list = (await this.dav.propfind(`${this.root}/devices`)) ?? []
      names = list.filter(e => !e.isDir && e.name.endsWith('.json.gz') && e.name !== this.ownName).map(e => e.name)
    }
    const files = await Promise.all(
      names.map(async name => {
        const key = `devices/${name}`
        const r = await this.dav.getIfChanged(`${this.root}/devices/${name}`, this.memo.etags[key]).catch(() => null)
        if (!r || r.notModified) return null
        if (r.etag) this.memo.etags[key] = r.etag
        return this.parseDevice(await gunzipText(r.bytes))
      }),
    )
    this.mergeCats(files)
    return this.mergeRecords(files.flatMap(f => (f ? Object.values(f.books) : [])))
  }

  /** 上传一本书的文件（用户选择“上传云端”时） */
  async uploadFile(rec: BookRecord) {
    if (rec.remotePath) return
    const bytes = await this.hooks.readBookFile(rec)
    if (!bytes) return
    await this.dav.ensureDir(`${this.root}/files`)
    await this.dav.put(this.filePath(rec), bytes)
  }

  /** v1 → v2：把旧的 books/*.json 读进来合并一次 */
  private async migrateLegacy() {
    if (this.memo.migrated === this.root) return
    const list = await this.dav.propfind(`${this.root}/books`).catch(() => null)
    if (list?.length) {
      const records: RemoteBook[] = []
      await pool(
        list.filter(e => !e.isDir && e.name.endsWith('.json')),
        6,
        async e => {
          const r = await this.dav.getJSON<RemoteBook>(`${this.root}/books/${e.name}`).catch(() => null)
          if (r) records.push(r)
        },
      )
      this.mergeRecords(records)
      this.hooks.log(tr('已从旧版同步格式迁移 {n} 本书的记录', { n: records.length }))
    }
    this.memo.migrated = this.root
  }

  /**
   * 全量同步。light：阅读中只同步阅读记录，书籍文件的上传/下载与云端新书导入留到退出阅读后再做，
   * 避免大文件的哈希、解压、传输和翻页抢主线程。
   */
  async syncAll(opts: { light?: boolean } = {}): Promise<SyncMemo> {
    const { log } = this.hooks
    const t0 = performance.now()
    this.dav.requests = 0
    await this.ensureDirs()

    // 三个目录列表并行获取
    const needRoot = this.cfg.scanRoot || this.cfg.syncSettings
    let [devList, rootList, filesList] = await Promise.all([
      this.dav.propfind(`${this.root}/devices`),
      needRoot ? this.dav.propfind(this.root) : Promise.resolve(null),
      this.cfg.syncFiles ? this.dav.propfind(`${this.root}/files`) : Promise.resolve(null),
    ])
    if (!devList) {
      await this.ensureDirs(true)
      devList = []
    }

    // 1. 拉取其他设备里变过的文件（并行）
    const changed = devList.filter(
      e => !e.isDir && e.name.endsWith('.json.gz') && e.name !== this.ownName && (!e.etag || this.memo.etags[`devices/${e.name}`] !== e.etag),
    )
    const records: RemoteBook[] = []
    const devFiles: DeviceFile[] = []
    await pool(changed, 4, async e => {
      const bytes = await this.dav.getBytes(`${this.root}/devices/${e.name}`).catch(() => null)
      if (!bytes) return
      const f = this.parseDevice(await gunzipText(bytes))
      if (f) {
        records.push(...Object.values(f.books))
        devFiles.push(f)
      }
      if (e.etag) this.memo.etags[`devices/${e.name}`] = e.etag
    })
    this.mergeCats(devFiles)
    const merged = this.mergeRecords(records)
    if (merged) log(tr('合并了 {n} 本书的阅读记录', { n: merged }))

    // 2. 首次升级：迁移旧格式
    await this.migrateLegacy()

    // 3. 扫描你手动放进云端根目录的书
    if (this.cfg.scanRoot && rootList && !opts.light) await this.scanRoot(rootList)

    // 4. 上传本机设备文件（没变化就跳过）
    if (await this.push()) log(tr('已上传本机阅读记录'))

    // 5. 书籍文件
    if (this.cfg.syncFiles && filesList && !opts.light) await this.syncFiles(filesList)

    // 6. 设置（电脑/手机分开）
    if (this.cfg.syncSettings && rootList) await this.syncSettings(rootList)

    log(tr('同步完成 · {s} 秒 · {n} 个请求', { s: ((performance.now() - t0) / 1000).toFixed(1), n: this.dav.requests }))
    return this.memo
  }

  private async scanRoot(entries: DavEntry[]) {
    const known = new Set(this.hooks.getLibrary().map(b => b.remotePath).filter(Boolean))
    for (const e of entries) {
      if (e.isDir || !BOOK_EXT.test(e.name)) continue
      const remotePath = `${this.root}/${e.name}`
      if (known.has(remotePath) || this.memo.scanned[remotePath] === e.etag) continue
      this.hooks.log(tr('发现云端新书《{name}》，正在导入…', { name: e.name }))
      const bytes = await this.download(remotePath, e.name.replace(/\.[^.]+$/, ''), e.size).catch(() => null)
      if (!bytes) continue
      const rec = await this.hooks.importRemoteFile(e.name, bytes, remotePath)
      this.memo.scanned[remotePath] = e.etag
      if (rec && !rec.remotePath) {
        const now = Date.now()
        this.hooks.saveBooks([{ ...rec, remotePath, deletedAt: undefined, metaUpdatedAt: now, updatedAt: now }])
      }
    }
  }

  /** 下载书籍文件并记录为传输任务（带进度） */
  private async download(path: string, title: string, size = 0) {
    const id = startTask('download', title, { total: size || undefined, loaded: 0, unit: 'bytes' })
    try {
      const bytes = await this.dav.getBytesProgress(path, (loaded, total) => updateTask(id, { loaded, total: total || size || undefined }))
      if (!bytes) throw new Error(tr('云端没有这个文件'))
      endTask(id)
      return bytes
    } catch (e) {
      endTask(id, e)
      throw e
    }
  }

  /** 上传书籍文件并记录为传输任务（浏览器接口无法报告上传进度，显示文件大小） */
  private async upload(path: string, title: string, bytes: Uint8Array) {
    const id = startTask('upload', title, { total: bytes.byteLength, unit: 'bytes' })
    try {
      await this.dav.put(path, bytes)
      endTask(id)
    } catch (e) {
      endTask(id, e)
      throw e
    }
  }

  private async syncFiles(list: DavEntry[]) {
    const { log } = this.hooks
    const files = new Set(list.map(e => e.name))
    const sizes = new Map(list.map(e => [e.name, e.size]))
    const books = this.hooks.getLibrary().filter(b => !b.deletedAt && !b.localOnly)
    const inCloud = (b: BookRecord) => !!b.remotePath || files.has(`${b.hash}.${b.format}`)
    // 上传：云端没有，或本机修改过书籍文件（编辑了书籍信息）
    const uploads = books.filter(b => b.hasFile && ((!b.remotePath && !inCloud(b)) || b.pendingUpload))
    // 下载：本机没有，或其他设备更新过文件
    const downloads = books.filter(
      b => !b.pendingUpload && inCloud(b) && (!b.hasFile || (b.fileRev ?? 0) > (b.fileRevLocal ?? 0)),
    )
    await pool(uploads, 3, async rec => {
      const bytes = await this.hooks.readBookFile(rec)
      if (!bytes) return
      log(tr('上传《{title}》', { title: rec.title }))
      await this.upload(this.filePath(rec), rec.title, bytes)
      const cur = this.hooks.getLibrary().find(b => b.hash === rec.hash)
      if (cur?.pendingUpload) this.hooks.saveBooks([{ ...cur, pendingUpload: false }])
    })
    await pool(downloads, 3, async rec => {
      log(tr(rec.hasFile ? '更新《{title}》' : '下载《{title}》', { title: rec.title }))
      const bytes = await this.download(this.filePath(rec), rec.title, sizes.get(`${rec.hash}.${rec.format}`)).catch(() => null)
      if (!bytes) return
      await this.hooks.writeBookFile(rec, bytes)
      const cur = this.hooks.getLibrary().find(b => b.hash === rec.hash)
      if (cur) this.hooks.saveBooks([{ ...cur, hasFile: true, fileRevLocal: cur.fileRev ?? 0 }])
    })
  }

  private async syncSettings(rootList: DavEntry[]) {
    const path = `${this.root}/${this.settingsName}`
    const key = this.settingsName
    const entry = rootList.find(e => e.name === this.settingsName)
    const local = this.hooks.getSettings()
    if (entry && (!entry.etag || this.memo.etags[key] !== entry.etag)) {
      const remote = await this.dav.getJSON<Settings>(path).catch(() => null)
      if (entry.etag) this.memo.etags[key] = entry.etag
      if (remote) {
        this.memo.settingsAt = remote.updatedAt
        if (remote.updatedAt > local.updatedAt) {
          this.hooks.applySettings(remote)
          this.hooks.log(tr('已应用云端设置'))
          return
        }
      }
    }
    if (!entry || local.updatedAt > (this.memo.settingsAt ?? 0)) {
      const tag = await this.dav.putJSON(path, local)
      this.memo.settingsAt = local.updatedAt
      // 记下服务器返回的 ETag，下次就不会把自己刚传的设置再下载一遍
      if (tag) this.memo.etags[key] = tag
      else delete this.memo.etags[key]
    }
  }

  /** 下载单个书籍文件（点击云端书籍时） */
  async downloadFile(rec: BookRecord) {
    const bytes = await this.download(this.filePath(rec), rec.title).catch(() => null)
    if (!bytes) throw new Error(tr('云端没有这本书的文件，请在原设备开启“同步书籍文件”'))
    await this.hooks.writeBookFile(rec, bytes)
    return bytes
  }

  async deleteFile(rec: BookRecord) {
    // 只删除 Readly 自己上传的副本；你手动放入的原文件不动
    if (!rec.remotePath) await this.dav.remove(this.filePath(rec)).catch(() => {})
  }
}

/** 常用 WebDAV 服务 */
export const DAV_PRESETS = [
  {
    id: 'koofr',
    name: 'Koofr',
    url: 'https://app.koofr.net/dav/Koofr',
  },
  {
    id: 'jianguoyun',
    name: '坚果云',
    url: 'https://dav.jianguoyun.com/dav/',
  },
] as const
