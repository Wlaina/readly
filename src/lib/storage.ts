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

export async function writeBytes(path: string, data: Uint8Array) {
  if (isTauri) {
    const f = await fs()
    await ensureDir(path)
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
  book: (hash: string, ext: string) => `books/${hash}.${ext}`,
  cover: (hash: string) => `covers/${hash}.img`,
  /** 缩小后的封面（thumb / large），由原图生成，可以随时删掉重建 */
  coverCache: (hash: string, size: string) => `covers/${hash}.${size}.webp`,
  font: (id: string, ext: string) => `fonts/${id}.${ext}`,
}
