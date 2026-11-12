/**
 * 书籍文件夹：选一个本地文件夹，之后放进去的 EPUB / TXT 自动加入书架。
 * Windows 直接读路径；安卓通过系统“选择文件夹”授权（SAF），由 MainActivity 桥接。
 */
import { isTauri } from './storage'
import { isAndroid } from './device'
import { tr } from './i18n'

export interface WatchedFolder {
  id: string
  name: string
  /** Windows 路径 */
  path?: string
  /** 安卓 SAF 树 URI */
  uri?: string
  /** 已处理过的文件：rel|size|mtime -> 书籍 hash（或 'skip'） */
  known: Record<string, string>
  /** 文件路径 -> 书籍 hash；同一路径的文件被修改时据此更新原书而不是新增 */
  paths?: Record<string, string>
  lastScan?: number
  count?: number
  error?: string
  /** 无法导入（文件损坏）的书名 */
  failed?: string[]
}

export interface FolderEntry {
  rel: string
  size: number
  mtime: number
  /** 安卓 documentId */
  id?: string
}

export const foldersSupported = isTauri

const bridge = () => (window as any).ReadlyAndroid

export const entryKey = (e: FolderEntry) => `${e.rel}|${e.size}|${e.mtime}`
export const entryName = (e: FolderEntry) => e.rel.split('/').pop() ?? e.rel

export async function pickFolder(): Promise<{ name: string; path?: string; uri?: string } | null> {
  if (isAndroid && bridge()?.pickFolder) {
    return new Promise(resolve => {
      ;(window as any).__readlyFolderPicked = (r: { uri: string; name: string } | null) => {
        delete (window as any).__readlyFolderPicked
        resolve(r ? { name: decodeURIComponent(r.name), uri: r.uri } : null)
      }
      bridge().pickFolder()
    })
  }
  const { open } = await import('@tauri-apps/plugin-dialog')
  const p = await open({ directory: true, multiple: false, title: tr('选择要同步的书籍文件夹') })
  if (!p || typeof p !== 'string') return null
  return { name: p.split(/[\\/]/).filter(Boolean).pop() ?? p, path: p }
}

export async function listFolder(f: WatchedFolder): Promise<FolderEntry[]> {
  if (f.uri) {
    const raw = JSON.parse(bridge()?.scanFolder(f.uri) ?? '[]')
    if (!Array.isArray(raw)) throw new Error(raw.error ?? tr('无法读取文件夹'))
    return raw
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<FolderEntry[]>('scan_folder', { path: f.path })
}

export async function readFolderEntry(f: WatchedFolder, e: FolderEntry): Promise<Uint8Array> {
  const { invoke } = await import('@tauri-apps/api/core')
  if (f.uri) {
    const path: string = bridge()?.copyFolderFile(f.uri, e.id, entryName(e)) ?? ''
    if (!path) throw new Error(tr('无法读取 {name}', { name: e.rel }))
    return new Uint8Array(await invoke<ArrayBuffer>('read_cache_file', { path }))
  }
  return new Uint8Array(await invoke<ArrayBuffer>('read_folder_file', { root: f.path, rel: e.rel }))
}

export function releaseFolder(f: WatchedFolder) {
  if (f.uri) bridge()?.releaseFolder?.(f.uri)
}
