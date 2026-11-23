/**
 * 本地存储抽象：Tauri 下写入应用数据目录，浏览器开发模式下落到 IndexedDB。
 * 路径统一使用 "books/xxx.epub" 这种相对形式。
 */
import { get, set, del } from 'idb-keyval'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

type FsModule = typeof import('@tauri-apps/plugin-fs')
let fsPromise: Promise<FsModule> | null = null
const fs = () => (fsPromise ??= import('@tauri-apps/plugin-fs'))

const madeDirs = new Set<string>()
async function ensureDir(path: string) {
  const i = path.lastIndexOf('/')
  if (i <= 0) return
  const dir = path.slice(0, i)
  if (madeDirs.has(dir)) return
  const f = await fs()
  await f.mkdir(dir, { baseDir: f.BaseDirectory.AppData, recursive: true }).catch(() => {})
  madeDirs.add(dir)
}

export async function readBytes(path: string): Promise<Uint8Array | null> {
  if (isTauri) {
    const f = await fs()
    const opts = { baseDir: f.BaseDirectory.AppData }
    if (!(await f.exists(path, opts))) return null
    return await f.readFile(path, opts)
  }
  const v = await get<Uint8Array>(path)
  return v ?? null
}

type AndroidBridge = { writeChunk(path: string, b64: string, append: boolean): boolean; commitFile(path: string): boolean }
const androidBridge = () => (window as unknown as { ReadlyAndroid?: Partial<AndroidBridge> }).ReadlyAndroid

let dataDir: Promise<string> | null = null
/** 分成 2MB 一块转成 base64（FileReader 不占主线程） */
const toBase64 = (part: Uint8Array) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(new Blob([part as BlobPart]))
  })

/**
 * 安卓上写大文件：Tauri 把二进制传进原生层时会变成一长串数字的 JSON（几十 MB 的书要卡住界面十几秒），
 * 所以分块交给 MainActivity 写，每块之间让出主线程。失败返回 false，退回原来的写法
 */
async function writeBigAndroid(path: string, data: Uint8Array): Promise<boolean> {
  const bridge = androidBridge()
  if (!bridge?.writeChunk || !bridge.commitFile) return false
  try {
    dataDir ??= import('@tauri-apps/api/path').then(p => p.appDataDir())
    const abs = `${(await dataDir).replace(/\/+$/, '')}/${path}`
    const CHUNK = 2 * 1024 * 1024
    for (let i = 0; i < data.length; i += CHUNK) {
      const b64 = await toBase64(data.subarray(i, Math.min(data.length, i + CHUNK)))
      if (!bridge.writeChunk(abs, b64, i > 0)) return false
    }
    return bridge.commitFile(abs)
  } catch (e) {
    console.warn('分块写文件失败，改用普通写法', path, e)
    return false
  }
}

export async function writeBytes(path: string, data: Uint8Array) {
  if (isTauri) {
    const f = await fs()
    await ensureDir(path)
    if (data.length > 1024 * 1024 && (await writeBigAndroid(path, data))) return
    await f.writeFile(path, data, { baseDir: f.BaseDirectory.AppData })
    return
  }
  await set(path, data)
}

export async function removeFile(path: string) {
  if (isTauri) {
    const f = await fs()
    const opts = { baseDir: f.BaseDirectory.AppData }
    if (await f.exists(path, opts)) await f.remove(path, opts)
    return
  }
  await del(path)
}

export async function readJSON<T>(path: string, fallback: T): Promise<T> {
  try {
    const bytes = await readBytes(path)
    if (!bytes) return fallback
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch (e) {
    console.error('readJSON failed', path, e)
    return fallback
  }
}

export async function writeJSON(path: string, data: unknown) {
  await writeBytes(path, new TextEncoder().encode(JSON.stringify(data)))
}

export const paths = {
  library: 'library.json',
  settings: 'settings.json',
  sync: 'sync.json',
  fonts: 'fonts.json',
  folders: 'folders.json',
  categories: 'categories.json',
  /** 在线书架：收藏的在线书、目录快照与阅读进度 */
  online: 'online.json',
  book: (hash: string, ext: string) => `books/${hash}.${ext}`,
  cover: (hash: string) => `covers/${hash}.img`,
  /** 缩小后的封面（thumb / large），由原图生成，可以随时删掉重建 */
  coverCache: (hash: string, size: string) => `covers/${hash}.${size}.webp`,
  font: (id: string, ext: string) => `fonts/${id}.${ext}`,
}
