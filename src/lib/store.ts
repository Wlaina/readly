import { useRef } from 'react'
import { create } from 'zustand'
import { isProtected, protect, unprotect } from './secret'
import type { Annotation, BookRecord, Bookmark, Category, CustomFont, Progress } from './types'
import { DEFAULT_SETTINGS, mergeSettings, type Settings, type ShelfSort } from './settings'
import { DEFAULT_SYNC, SyncEngine, type SyncConfig, type SyncMemo } from './sync'
import { paths, readBytes, readJSON, removeFile, writeBytes, writeJSON } from './storage'
import { openBook, parseImport } from './book'
import { endTask, runTask, startTask, updateTask, useTasks } from './tasks'
import { setEpubMetadata } from './epubedit'
import { invalidateCover } from './covers'
import { backgroundPut, isWindowsApp, writeFolderFile } from './native'
import { registerCustomFont, unregisterCustomFont } from './fonts'
import { dayKey, getDevice, initDevice } from './device'
import { hashBytes } from './book'
import {
  entryKey,
  entryName,
  foldersSupported,
  listFolder,
  pickFolder,
  readFolderEntry,
  releaseFolder,
  type WatchedFolder,
} from './folders'
import { tr } from './i18n'
import { isEn } from './i18n'

export type SyncStatus = 'idle' | 'syncing' | 'ok' | 'error'

interface SyncState extends SyncMemo {
  lastSyncAt?: number
}

export interface ImportOptions {
  /** 仅本机阅读，不上传云端 */
  localOnly?: boolean
  silent?: boolean
  /** 不为单本失败弹提示（由调用方汇总） */
  quietErrors?: boolean
}

interface State {
  ready: boolean
  library: BookRecord[]
  settings: Settings
  sync: SyncConfig
  syncStatus: SyncStatus
  syncMessage: string
  syncLog: string[]
  lastSyncAt?: number
  customFonts: CustomFont[]
  toast: string | null
  /** 正在阅读的书 */
  reading: string | null
  /** 书籍文件夹（仅本机） */
  folders: WatchedFolder[]
  folderScanning: boolean
  /** 书架分类（含已删除的标记，显示时用 liveCategories 过滤） */
  categories: Category[]

  init: () => Promise<void>
  addCategory: (name: string) => string
  renameCategory: (id: string, name: string) => void
  removeCategory: (id: string) => void
  /** 把分类往前（-1）或往后（1）挪一位 */
  moveCategory: (id: string, dir: -1 | 1) => void
  /** 把这些书加入 / 移出某个分类 */
  setBooksCategory: (hashes: string[], catId: string, on: boolean) => void
  /**
   * 离开应用（切后台、关窗口）时调用：立刻保存进度并上传本机阅读记录。
   * 安卓上交给原生线程上传（网页随时可能被系统暂停）；返回的 Promise 在上传结束或超时后完成。
   */
  pushOnLeave: (timeoutMs?: number) => Promise<void>
  addFolder: () => Promise<void>
  removeFolder: (id: string) => void
  scanFolders: (manual?: boolean) => Promise<void>
  importFiles: (files: File[], opts?: ImportOptions) => Promise<BookRecord[]>
  removeBook: (hash: string) => Promise<void>
  removeBooks: (hashes: string[]) => Promise<void>
  setLocalOnly: (hash: string, localOnly: boolean) => Promise<void>
  saveProgress: (hash: string, p: Progress) => void
  addBookmark: (hash: string, bm: Omit<Bookmark, 'id' | 'createdAt' | 'updatedAt'>) => void
  removeBookmark: (hash: string, id: string) => void
  /** 新增或修改高亮/笔记（传入 id 时为修改） */
  saveAnnotation: (hash: string, a: Omit<Annotation, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) => string
  removeAnnotation: (hash: string, id: string) => void
  /** 累加本机在这本书上的阅读时长 */
  addReadingTime: (hash: string, ms: number) => void
  /** 清除这些书的阅读统计（所有设备同步清除） */
  clearStats: (hashes: string[]) => void
  /** 编辑书籍信息：更新书架、写入 EPUB 文件、写回书籍文件夹、上传云端 */
  editBook: (hash: string, meta: { title: string; author: string }) => Promise<void>
  /** 书籍文件被外部修改：用新文件更新这本书（保留进度、书签、统计） */
  updateBookFile: (hash: string, bytes: Uint8Array, fileName: string, folderRef?: BookRecord['folderRef']) => Promise<void>
  updateSettings: (fn: (s: Settings) => Settings) => void
  updateSync: (patch: Partial<SyncConfig>) => void
  testSync: () => Promise<boolean>
  runSync: () => Promise<void>
  /** 快速同步：pull 拉取其他设备进度，push 上传本机记录，both 两者都做 */
  syncQuick: (mode: 'pull' | 'push' | 'both', timeoutMs?: number) => Promise<void>
  loadBookFile: (rec: BookRecord) => Promise<Uint8Array>
  importFont: (file: File) => Promise<void>
  removeFont: (id: string) => Promise<void>
  openReader: (hash: string | null) => void
  showToast: (msg: string) => void
}

/* 写盘防抖：翻页时只改内存，空闲再落盘 */
const debounced = <T extends unknown[]>(fn: (...a: T) => void, ms: number) => {
  let t: ReturnType<typeof setTimeout> | undefined
  return (...a: T) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }
}

let syncState: SyncState = { etags: {}, scanned: {} }
let syncing: Promise<void> | null = null
let toastTimer: ReturnType<typeof setTimeout> | undefined
let autoTimer: ReturnType<typeof setInterval> | undefined
let folderScan: Promise<void> | null = null
/** 当前解析器也无法导入的文件标记；解析器升级时改这个值，失败的书会自动重试一次 */
const SKIP_MARK = 'skip:v2'
/** 阅读期间推迟了重活，退出阅读后补做 */
let deferredHeavy = false
/** 正在进行的全量同步任务 */
let currentSyncTask: string | null = null
let lastFolderScan = 0

/**
 * 离开阅读页（退出书籍、切后台、关窗口）之前要立刻做完的事：阅读器在这里登记“保存当前进度、结算阅读时长”。
 * 这样书架在阅读器开始退场的那一刻就已经是最新进度。
 */
export const beforeLeave = new Set<() => void>()
const runBeforeLeave = () => {
  for (const fn of [...beforeLeave]) {
    try {
      fn()
    } catch (e) {
      console.warn('保存阅读进度失败', e)
    }
  }
}

/**
 * 记住“正在读哪本书”：安卓随时可能在后台把应用整个回收，回来时是一次重新启动。
 * 如果离开还没多久，启动时就直接回到那本书，而不是把你丢回书架。
 */
const SESSION_KEY = 'readly.session'
function markSession(hash: string | null) {
  try {
    if (hash) localStorage.setItem(SESSION_KEY, JSON.stringify({ hash, t: Date.now() }))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    /* 存储不可用就算了 */
  }
}
/** 上次是不是在阅读途中被中断的（30 分钟以内）：是的话返回那本书 */
export function interruptedBook(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as { hash?: string; t?: number }
    return s.hash && Date.now() - (s.t ?? 0) < 30 * 60_000 ? s.hash : null
  } catch {
    return null
  }
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const useStore = create<State>((set, get) => {
  const persistLibrary = debounced(() => writeJSON(paths.library, get().library), 2500)
  const persistCategories = debounced(() => writeJSON(paths.categories, get().categories), 300)
  const setCategories = (categories: Category[]) => {
    set({ categories })
    persistCategories()
  }
  const persistSettings = debounced(() => writeJSON(paths.settings, get().settings), 500)
  const persistFolders = debounced(() => writeJSON(paths.folders, get().folders), 300)
  // 写盘时把 WebDAV 密码加密（见 lib/secret.ts）；内存里仍是明文
  const persistSync = debounced(async () => {
    const config = get().sync
    writeJSON(paths.sync, { config: { ...config, password: await protect(config.password) }, state: syncState })
  }, 300)

  /** 从 EPUB 文件里提取封面并保存；没有封面的书也做个标记，不再反复尝试 */
  const extractCover = async (hash: string, format: string, bytes: Uint8Array) => {
    if (format !== 'epub') return
    try {
      const book = await openBook('epub', bytes, `${hash}.epub`)
      const blob: Blob | null = await Promise.resolve(book.getCover?.()).catch(() => null)
      book.destroy?.()
      if (blob) {
        await writeBytes(paths.cover(hash), new Uint8Array(await blob.arrayBuffer()))
        invalidateCover(hash)
      }
      patchBook(hash, b => ({ ...b, hasCover: !!blob || b.hasCover, coverChecked: true, coverRev: blob ? Date.now() : b.coverRev }))
    } catch (e) {
      console.warn('提取封面失败', hash, e)
      patchBook(hash, b => ({ ...b, coverChecked: true }))
    }
  }

  const backfillCovers = async () => {
    const todo = get().library.filter(b => b.format === 'epub' && b.hasFile && !b.hasCover && !b.coverChecked && !b.deletedAt)
    for (const b of todo) {
      // 阅读时不做，等退出阅读
      while (get().reading) await new Promise(r => setTimeout(r, 3000))
      const bytes = await readBytes(paths.book(b.hash, b.format))
      if (bytes) await extractCover(b.hash, b.format, bytes)
      await new Promise(r => setTimeout(r, 150)) // 让出主线程
    }
  }

  /**
   * 把书籍文件写回它来自的书籍文件夹（仅电脑端，有 Windows 路径的文件夹）。
   * 写完记下新文件的“路径|大小|时间”，下次扫描就知道这是自己写的，不会当成外部修改。
   */
  const writeBackToFolder = async (rec: BookRecord, bytes: Uint8Array) => {
    const ref = rec.folderRef
    const folder = ref && get().folders.find(f => f.id === ref.folderId)
    if (!ref || !folder?.path || !isWindowsApp) return false
    const entry = await writeFolderFile(folder.path, ref.rel, bytes)
    set({
      folders: get().folders.map(f =>
        f.id === folder.id
          ? { ...f, known: { ...f.known, [entryKey(entry)]: rec.hash }, paths: { ...f.paths, [ref.rel]: rec.hash } }
          : f,
      ),
    })
    persistFolders()
    return true
  }

  const putBooks = (books: BookRecord[]) => {
    const map = new Map(get().library.map(b => [b.hash, b]))
    for (const b of books) map.set(b.hash, b)
    set({ library: [...map.values()] })
    persistLibrary()
  }

  const patchBook = (hash: string, fn: (b: BookRecord) => BookRecord) => {
    set({ library: get().library.map(b => (b.hash === hash ? fn(b) : b)) })
    persistLibrary()
  }

  const log = (msg: string) => {
    set({ syncMessage: msg, syncLog: [...get().syncLog.slice(-60), `${new Date().toLocaleTimeString()}  ${msg}`] })
    // 同步进行中：当前步骤显示在任务上
    if (currentSyncTask) updateTask(currentSyncTask, { detail: msg })
  }

  /** 保存解析好的书：写文件、写封面、更新书架 */
  const storeParsed = async (parsed: Awaited<ReturnType<typeof parseImport>>, extra: Partial<BookRecord>) => {
    const { rec, bytes, cover } = parsed
    const exist = get().library.find(b => b.hash === rec.hash)
    await writeBytes(paths.book(rec.hash, rec.format), bytes)
    if (cover) await writeBytes(paths.cover(rec.hash), new Uint8Array(await cover.arrayBuffer()))
    const now = Date.now()
    const next: BookRecord = exist
      ? {
          ...exist,
          hasFile: true,
          hasCover: exist.hasCover || !!cover,
          ...(exist.deletedAt ? { deletedAt: undefined, metaUpdatedAt: now, updatedAt: now } : {}),
          ...extra,
        }
      : { ...rec, ...extra }
    putBooks([next])
    return next
  }

  const engine = () =>
    new SyncEngine(
      get().sync,
      {
        getLibrary: () => get().library,
        saveBooks: putBooks,
        readBookFile: rec => readBytes(paths.book(rec.hash, rec.format)),
        writeBookFile: async (rec, bytes) => {
          await writeBytes(paths.book(rec.hash, rec.format), bytes)
          // 从云端下载下来的书：顺手提取封面
          extractCover(rec.hash, rec.format, bytes)
          // 其他设备修改过的书：也写回本机书籍文件夹里的原文件，OneDrive 等会继续同步出去
          const cur = get().library.find(b => b.hash === rec.hash)
          if (cur?.folderRef && (cur.fileRev ?? 0) > (cur.fileRevLocal ?? 0))
            await writeBackToFolder(cur, bytes).catch(e => console.warn('写回书籍文件夹失败', e))
        },
        importRemoteFile: async (name, bytes, remotePath) => {
          try {
            const parsed = await parseImport(new File([bytes as BlobPart], name))
            return await storeParsed(parsed, { remotePath })
          } catch (e) {
            log(tr('导入《{name}》失败：{e}', { name, e: e instanceof Error ? e.message : String(e) }))
            return null
          }
        },
        getSettings: () => get().settings,
        applySettings: s => {
          // 引导是否看过只属于这台设备，不被云端设置覆盖
          set({ settings: { ...mergeSettings(s), onboarded: get().settings.onboarded } })
          persistSettings()
        },
        getCategories: () => get().categories,
        saveCategories: setCategories,
        log,
      },
      syncState,
    )

  const canSync = () => {
    const s = get().sync
    return s.enabled && !!s.url && !!s.username && !!s.password
  }

  const scheduleAuto = () => {
    clearInterval(autoTimer)
    const min = get().sync.interval
    if (canSync() && min > 0) autoTimer = setInterval(() => get().runSync(), min * 60_000)
  }

  return {
    ready: false,
    library: [],
    settings: DEFAULT_SETTINGS,
    sync: DEFAULT_SYNC,
    syncStatus: 'idle',
    syncMessage: '',
    syncLog: [],
    customFonts: [],
    toast: null,
    reading: null,
    folders: [],
    folderScanning: false,
    categories: [],

    async init() {
      const [library, settings, syncFile, fonts, folders, categories] = await Promise.all([
        initDevice().then(() => readJSON<BookRecord[]>(paths.library, [])),
        readJSON<Partial<Settings> | null>(paths.settings, null),
        readJSON<{ config?: SyncConfig; state?: SyncState }>(paths.sync, {}),
        readJSON<CustomFont[]>(paths.fonts, []),
        readJSON<WatchedFolder[]>(paths.folders, []),
        readJSON<Category[]>(paths.categories, []),
      ])
      set({ folders, categories: Array.isArray(categories) ? categories : [] })
      syncState = { etags: {}, scanned: {}, ...syncFile.state }
      const storedPassword = syncFile.config?.password ?? ''
      const password = await unprotect(storedPassword)
      set({
        ready: true,
        library,
        // 没有设置文件 = 第一次启动：显示引导页
        settings: settings ? mergeSettings(settings) : { ...mergeSettings(null), onboarded: false },
        sync: { ...DEFAULT_SYNC, ...syncFile.config, password },
        lastSyncAt: syncState.lastSyncAt,
        customFonts: fonts,
      })
      // 旧版本留下的明文密码：立刻换成加密存放；解不开时（换了账户/重装）提示重新输入
      if (storedPassword && !isProtected(storedPassword)) persistSync()
      else if (storedPassword && !password) setTimeout(() => get().showToast(tr('需要重新输入 WebDAV 密码')), 1500)
      // 以前同步下来却没有封面的书：后台慢慢补上
      setTimeout(backfillCovers, 4000)
      // 字体异步注册，不阻塞首屏
      for (const f of fonts) readBytes(paths.font(f.id, f.ext)).then(bytes => bytes && registerCustomFont(f, bytes))
      if (canSync()) setTimeout(() => get().runSync(), 1200)
      scheduleAuto()
      // 书籍文件夹：启动后扫一次，之后每 2 分钟扫一次（阅读时不打扰）
      if (folders.length) setTimeout(() => get().scanFolders(), 2500)
      setInterval(() => !get().reading && get().scanFolders(), 120_000)
      // 切回应用时同步（手机从后台回来、电脑切换窗口）
      let lastVisible = Date.now()
      document.addEventListener('visibilitychange', () => {
        // 切到后台时的落盘与上传由 App 统一调用 pushOnLeave（不在这里再写一遍，避免两处同时写同一个文件）
        if (document.visibilityState === 'hidden') return
        if (Date.now() - lastVisible > 60_000) get().runSync()
        if (Date.now() - lastFolderScan > 30_000 && !get().reading) get().scanFolders()
        lastVisible = Date.now()
      })
    },

    addCategory(name) {
      const clean = name.trim().slice(0, 40)
      const live = get().categories.filter(c => !c.deleted)
      const same = live.find(c => c.name === clean)
      if (!clean || same) return same?.id ?? ''
      const cat: Category = { id: newId(), name: clean, order: Math.max(0, ...live.map(c => c.order)) + 1, updatedAt: Date.now() }
      setCategories([...get().categories, cat])
      get().syncQuick('push')
      return cat.id
    },

    renameCategory(id, name) {
      const clean = name.trim().slice(0, 40)
      if (!clean) return
      setCategories(get().categories.map(c => (c.id === id ? { ...c, name: clean, updatedAt: Date.now() } : c)))
      get().syncQuick('push')
    },

    removeCategory(id) {
      // 只留下删除标记；书上残留的分类 id 在显示时会被忽略
      setCategories(get().categories.map(c => (c.id === id ? { ...c, deleted: true, updatedAt: Date.now() } : c)))
      get().syncQuick('push')
    },

    moveCategory(id, dir) {
      const live = get()
        .categories.filter(c => !c.deleted)
        .sort((a, b) => a.order - b.order)
      const i = live.findIndex(c => c.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= live.length) return
      ;[live[i], live[j]] = [live[j], live[i]]
      const now = Date.now()
      const order = new Map(live.map((c, k) => [c.id, k + 1]))
      setCategories(get().categories.map(c => (order.has(c.id) && order.get(c.id) !== c.order ? { ...c, order: order.get(c.id)!, updatedAt: now } : c)))
      get().syncQuick('push')
    },

    setBooksCategory(hashes, catId, on) {
      const pick = new Set(hashes)
      const now = Date.now()
      set({
        library: get().library.map(b => {
          if (!pick.has(b.hash)) return b
          const cur = b.categories ?? []
          if (cur.includes(catId) === on) return b
          return { ...b, categories: on ? [...cur, catId] : cur.filter(x => x !== catId), catsAt: now, updatedAt: now }
        }),
      })
      persistLibrary()
      get().syncQuick('push')
    },

    async pushOnLeave(timeoutMs = 0) {
      runBeforeLeave()
      markSession(get().reading)
      // 立刻落盘：手机上应用随时可能被系统回收，电脑上窗口马上就要关
      const saved = Promise.all([writeJSON(paths.library, get().library), writeJSON(paths.settings, get().settings)]).catch(() => {})
      if (canSync()) {
        // 安卓：把内容交给原生线程去传，网页被暂停也不影响
        const up = engine().ownUpload()
        if (up && backgroundPut(up.url, up.auth, up.text)) return void (await saved)
        await Promise.all([saved, get().syncQuick('push', timeoutMs)])
      } else await saved
    },

    async addFolder() {
      if (!foldersSupported) return
      const picked = await pickFolder().catch(e => {
        get().showToast(tr('无法选择文件夹：{e}', { e: String(e) }))
        return null
      })
      if (!picked) return
      if (get().folders.some(f => (f.path && f.path === picked.path) || (f.uri && f.uri === picked.uri)))
        return get().showToast(tr('这个文件夹已经在同步了'))
      const folder: WatchedFolder = { id: Date.now().toString(36), ...picked, known: {} }
      set({ folders: [...get().folders, folder] })
      persistFolders()
      get().showToast(tr('已添加文件夹「{name}」，正在导入里面的书…', { name: folder.name }))
      await get().scanFolders(true)
    },

    removeFolder(id) {
      const f = get().folders.find(x => x.id === id)
      if (f) releaseFolder(f)
      set({ folders: get().folders.filter(x => x.id !== id) })
      persistFolders()
    },

    async scanFolders(manual = false) {
      if (!foldersSupported || !get().folders.length) return
      // 阅读时不扫描，退出阅读后再补
      if (get().reading) {
        deferredHeavy = true
        return
      }
      if (folderScan) return folderScan
      lastFolderScan = Date.now()
      set({ folderScanning: true })
      folderScan = (async () => {
        let added = 0
        let updated = 0
        let failedTotal = 0
        const live = (hash: string) => get().library.find(b => b.hash === hash && !b.deletedAt)
        for (const folder of get().folders) {
          const known = { ...folder.known }
          const paths = { ...folder.paths }
          const failed: string[] = []
          let error: string | undefined
          let count = 0
          try {
            const entries = await listFolder(folder)
            count = entries.length
            // 先挑出需要处理的文件：没变化的直接跳过
            const todo = entries.filter(e => {
              const mark = known[entryKey(e)]
              if (mark === SKIP_MARK) {
                failed.push(entryName(e))
                return false
              }
              if (mark && mark !== 'skip') {
                // 记住“路径 → 书”，以后这个路径的文件被修改时能认出是同一本书
                paths[e.rel] ??= mark
                const b = live(mark)
                if (b && !b.folderRef) patchBook(mark, x => ({ ...x, folderRef: { folderId: folder.id, rel: e.rel } }))
                return false
              }
              return true
            })
            const tid = todo.length ? startTask('scan', tr('书籍文件夹「{name}」', { name: folder.name }), { total: todo.length, loaded: 0, unit: 'items' }) : null
            let done = 0
            for (const e of todo) {
              // 扫描途中打开了书：立刻停下，退出阅读后接着扫
              if (get().reading) {
                deferredHeavy = true
                break
              }
              const key = entryKey(e)
              if (tid) updateTask(tid, { loaded: done++, detail: entryName(e) })
              try {
                const bytes = await readFolderEntry(folder, e)
                const hash = await hashBytes(bytes)
                const exist = live(hash)
                if (exist?.hasFile) {
                  // 内容和书架上某本完全一样（例如改了文件名、或是 Readly 自己写回的）
                  known[key] = exist.hash
                  paths[e.rel] = exist.hash
                  if (!exist.folderRef || exist.folderRef.rel !== e.rel)
                    patchBook(exist.hash, x => ({ ...x, folderRef: { folderId: folder.id, rel: e.rel } }))
                  continue
                }
                const prevHash = paths[e.rel]
                const prev = prevHash ? live(prevHash) : undefined
                if (prev) {
                  // 同一路径的文件被外部修改了（资源管理器 / 其他工具）：更新原来那本书，不新增重复的书
                  await get().updateBookFile(prev.hash, bytes, entryName(e), { folderId: folder.id, rel: e.rel })
                  known[key] = prev.hash
                  updated++
                  continue
                }
                const [rec] = await get().importFiles([new File([bytes as BlobPart], entryName(e))], { silent: true, quietErrors: true })
                if (rec) {
                  known[key] = rec.hash
                  paths[e.rel] = rec.hash
                  patchBook(rec.hash, x => ({ ...x, folderRef: { folderId: folder.id, rel: e.rel } }))
                  added++
                } else {
                  known[key] = SKIP_MARK
                  failed.push(entryName(e))
                  failedTotal++
                }
              } catch (err) {
                console.warn(tr('导入失败'), e.rel, err)
                known[key] = SKIP_MARK
                failed.push(entryName(e))
                failedTotal++
              }
              await new Promise(r => setTimeout(r, 0)) // 让出主线程
            }
            if (tid) endTask(tid)
          } catch (err) {
            error = err instanceof Error ? err.message : String(err)
          }
          set({
            folders: get().folders.map(f => (f.id === folder.id ? { ...f, known, paths, count, error, failed, lastScan: Date.now() } : f)),
          })
        }
        persistFolders()
        // 汇总成一条提示，不再每本书弹一次
        const parts = [
          added && tr('新增 {n} 本书', { n: added }),
          updated && tr('{n} 本书的文件有更新', { n: updated }),
          failedTotal && tr('{n} 本书文件损坏无法导入', { n: failedTotal }),
        ].filter(Boolean)
        if (parts.length) get().showToast(tr('书籍文件夹：{list}', { list: parts.join(isEn() ? ', ' : '，') }))
        else if (manual) get().showToast(tr('书籍文件夹没有新书'))
      })().finally(() => {
        folderScan = null
        set({ folderScanning: false })
      })
      return folderScan
    },

    async importFiles(files, opts = {}) {
      const out: BookRecord[] = []
      const tid = files.length > 1 && !opts.silent ? startTask('import', tr('导入 {n} 本书', { n: files.length }), { total: files.length, loaded: 0, unit: 'items' }) : null
      for (const [i, file] of files.entries()) {
        if (tid) updateTask(tid, { loaded: i, detail: file.name })
        try {
          const parsed = await parseImport(file)
          out.push(await storeParsed(parsed, opts.localOnly ? { localOnly: true } : {}))
        } catch (e) {
          console.error(tr('导入失败：{name}', { name: file.name }), e)
          if (!opts.quietErrors) {
            const msg = e instanceof Error ? e.message : String(e)
            const friendly = /XML|parsing|groupBy|null|undefined/i.test(msg) ? tr('文件内部格式有误') : msg
            get().showToast(tr('《{name}》无法导入：{e}', { name: file.name.replace(/\.[^.]+$/, ''), e: friendly }))
          }
        }
      }
      if (tid) {
        updateTask(tid, { detail: files.length - out.length ? tr('成功 {ok} 本，失败 {bad} 本', { ok: out.length, bad: files.length - out.length }) : tr('成功 {ok} 本', { ok: out.length }) })
        endTask(tid)
      }
      if (out.length && !opts.silent) get().showToast(tr('已导入 {n} 本书', { n: out.length }))
      if (out.some(b => !b.localOnly) && canSync()) get().runSync()
      return out
    },

    async removeBook(hash) {
      return get().removeBooks([hash])
    },

    async removeBooks(hashes) {
      const set_ = new Set(hashes)
      const recs = get().library.filter(b => set_.has(b.hash))
      if (!recs.length) return
      const now = Date.now()
      await Promise.all(
        recs.flatMap(r => [removeFile(paths.book(r.hash, r.format)).catch(() => {}), removeFile(paths.cover(r.hash)).catch(() => {})]),
      )
      for (const r of recs) invalidateCover(r.hash)
      // 仅本机的书直接删掉；其余留下删除标记，让其它设备同步删除
      set({
        library: get()
          .library.filter(b => !(set_.has(b.hash) && b.localOnly))
          .map(b =>
            set_.has(b.hash) ? { ...b, deletedAt: now, metaUpdatedAt: now, updatedAt: now, hasFile: false, hasCover: false } : b,
          ),
      })
      persistLibrary()
      if (canSync()) {
        const e = engine()
        Promise.all(recs.filter(r => !r.localOnly).map(r => e.deleteFile(r))).finally(() => get().runSync())
      }
    },

    async setLocalOnly(hash, localOnly) {
      const now = Date.now()
      patchBook(hash, b => ({ ...b, localOnly, updatedAt: now, metaUpdatedAt: now, syncedAt: undefined }))
      if (!localOnly && canSync()) {
        get().showToast(tr('正在上传到云端…'))
        const rec = get().library.find(b => b.hash === hash)!
        await engine()
          .uploadFile(rec)
          .catch(e => get().showToast(tr('上传失败：{e}', { e: e instanceof Error ? e.message : String(e) })))
        await get().runSync()
      }
    },

    saveProgress(hash, p) {
      patchBook(hash, b => ({ ...b, progress: p, lastReadAt: p.updatedAt, updatedAt: p.updatedAt }))
    },

    addBookmark(hash, bm) {
      const now = Date.now()
      const full: Bookmark = { ...bm, id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: now, updatedAt: now }
      patchBook(hash, b => ({ ...b, bookmarks: [...b.bookmarks, full].sort((x, y) => x.fraction - y.fraction), updatedAt: now }))
    },

    removeBookmark(hash, id) {
      const now = Date.now()
      patchBook(hash, b => ({
        ...b,
        bookmarks: b.bookmarks.map(m => (m.id === id ? { ...m, deleted: true, updatedAt: now } : m)),
        updatedAt: now,
      }))
    },

    saveAnnotation(hash, a) {
      const now = Date.now()
      const id = a.id ?? `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
      patchBook(hash, b => {
        const list = b.annotations ?? []
        const exist = list.find(x => x.id === id)
        const next: Annotation = exist ? { ...exist, ...a, id, updatedAt: now } : { ...a, id, createdAt: now, updatedAt: now }
        const annotations = (exist ? list.map(x => (x.id === id ? next : x)) : [...list, next]).sort((x, y) => x.fraction - y.fraction)
        return { ...b, annotations, updatedAt: now }
      })
      return id
    },

    removeAnnotation(hash, id) {
      const now = Date.now()
      patchBook(hash, b => ({
        ...b,
        annotations: (b.annotations ?? []).map(x => (x.id === id ? { ...x, deleted: true, updatedAt: now } : x)),
        updatedAt: now,
      }))
    },

    addReadingTime(hash, ms) {
      if (ms <= 0) return
      const { id, name } = getDevice()
      const day = dayKey()
      patchBook(hash, b => {
        const cur = b.readStats?.[id] ?? { ms: 0, days: {}, device: name }
        return {
          ...b,
          readStats: {
            ...b.readStats,
            [id]: { ms: cur.ms + ms, days: { ...cur.days, [day]: (cur.days[day] ?? 0) + ms }, device: name },
          },
          updatedAt: Date.now(),
        }
      })
    },

    async editBook(hash, meta) {
      const rec = get().library.find(b => b.hash === hash)
      if (!rec) return
      const title = meta.title.trim() || rec.title
      const author = meta.author.trim()
      const now = Date.now()
      // 1. 书架上的信息（随阅读记录同步到其他设备）
      patchBook(hash, b => ({ ...b, title, author, metaUpdatedAt: now, updatedAt: now }))
      // 2. EPUB：把新信息写进书籍文件本身，并写回书籍文件夹、上传云端
      let fileNote = ''
      if (rec.format === 'epub' && rec.hasFile) {
        try {
          const bytes = await readBytes(paths.book(hash, rec.format))
          if (!bytes) throw new Error(tr('本机没有这本书的文件'))
          const out = setEpubMetadata(bytes, { title, author })
          await writeBytes(paths.book(hash, rec.format), out)
          const t = Date.now()
          patchBook(hash, b => ({ ...b, size: out.byteLength, fileRev: t, fileRevLocal: t, pendingUpload: !b.localOnly, updatedAt: t }))
          if (await writeBackToFolder(get().library.find(b => b.hash === hash)!, out)) fileNote = tr('，并已写回书籍文件夹')
        } catch (e) {
          console.error(e)
          fileNote = tr('（书籍文件未修改：{e}）', { e: e instanceof Error ? e.message : String(e) })
        }
      }
      get().showToast(tr('已保存《{title}》', { title }) + fileNote)
      if (canSync()) get().runSync()
    },

    async updateBookFile(hash, bytes, fileName, folderRef) {
      const rec = get().library.find(b => b.hash === hash)
      if (!rec) return
      const parsed = await parseImport(new File([bytes as BlobPart], fileName))
      await writeBytes(paths.book(hash, rec.format), bytes)
      if (parsed.cover) {
        await writeBytes(paths.cover(hash), new Uint8Array(await parsed.cover.arrayBuffer()))
        invalidateCover(hash)
      }
      const now = Date.now()
      patchBook(hash, b => ({
        ...b,
        // 文件里的书名作者是外部改的：以文件为准
        title: parsed.rec.title,
        author: parsed.rec.author,
        metaUpdatedAt: now,
        size: bytes.byteLength,
        hasFile: true,
        hasCover: b.hasCover || !!parsed.cover,
        coverRev: parsed.cover ? now : b.coverRev,
        fileRev: now,
        fileRevLocal: now,
        pendingUpload: !b.localOnly,
        folderRef: folderRef ?? b.folderRef,
        updatedAt: now,
      }))
      if (canSync()) setTimeout(() => get().runSync(), 1000)
    },

    clearStats(hashes) {
      const now = Date.now()
      const s = new Set(hashes)
      set({
        library: get().library.map(b => (s.has(b.hash) ? { ...b, readStats: undefined, statsClearedAt: now, updatedAt: now } : b)),
      })
      persistLibrary()
      get().syncQuick('push')
    },

    updateSettings(fn) {
      set({ settings: { ...fn(get().settings), updatedAt: Date.now() } })
      persistSettings()
    },

    updateSync(patch) {
      const prev = get().sync
      set({ sync: { ...prev, ...patch } })
      if (patch.url !== undefined || patch.root !== undefined || patch.username !== undefined)
        syncState = { etags: {}, scanned: {} }
      persistSync()
      scheduleAuto()
    },

    async testSync() {
      try {
        log(tr('测试连接…'))
        await engine().test()
        log(tr('连接成功'))
        return true
      } catch (e) {
        log(tr('连接失败：{e}', { e: e instanceof Error ? e.message : String(e) }))
        return false
      }
    },

    async runSync() {
      if (!canSync()) return
      if (syncing) return syncing
      set({ syncStatus: 'syncing' })
      const light = !!get().reading
      const taskId = startTask('sync', light ? tr('同步阅读记录（阅读中，书籍文件稍后同步）') : tr('全量同步'))
      currentSyncTask = taskId
      syncing = (async () => {
        try {
          if (light) deferredHeavy = true
          syncState = { ...syncState, ...(await engine().syncAll({ light })), lastSyncAt: Date.now() }
          set({ syncStatus: 'ok', lastSyncAt: syncState.lastSyncAt })
          persistSync()
          endTask(taskId)
        } catch (e) {
          console.error(e)
          const msg = e instanceof Error ? e.message : String(e)
          set({ syncStatus: 'error' })
          log(tr('同步失败：{e}', { e: msg }))
          endTask(taskId, e)
        } finally {
          syncing = null
          currentSyncTask = null
        }
      })()
      return syncing
    },

    async syncQuick(mode, timeoutMs = 0) {
      if (!canSync()) return
      const e = engine()
      const task = (async () => {
        // 拉取：并行条件请求其他设备的文件；上传：只传本机一个文件（没变就跳过）
        if (mode !== 'push') await runTask('pull', tr('拉取其他设备的阅读进度'), () => e.pull())
        if (mode !== 'pull') {
          // 上传前先判断有没有变化，没变化就不产生任务记录
          const id = startTask('push', tr('上传本机阅读记录'))
          const sent = await e.push().catch(err => {
            endTask(id, err)
            throw err
          })
          if (sent) endTask(id)
          else useTasks.setState(s => ({ tasks: s.tasks.filter(t => t.id !== id) }))
        }
        persistSync()
      })().catch(err => console.warn('快速同步失败', err))
      if (timeoutMs) await Promise.race([task, new Promise(r => setTimeout(r, timeoutMs))])
      else await task
    },

    async loadBookFile(rec) {
      const local = await readBytes(paths.book(rec.hash, rec.format))
      if (local) return local
      if (!canSync()) throw new Error(tr('本机没有这本书的文件，且未配置同步'))
      get().showToast(tr('正在从云端下载…'))
      const bytes = await engine().downloadFile(rec)
      patchBook(rec.hash, b => ({ ...b, hasFile: true }))
      return bytes
    },

    async importFont(file) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
      if (!['ttf', 'otf', 'woff', 'woff2'].includes(ext)) {
        get().showToast(tr('仅支持 ttf / otf / woff / woff2 字体'))
        return
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      const font: CustomFont = { id: Date.now().toString(36), name: file.name.replace(/\.[^.]+$/, ''), fileName: file.name, ext }
      await writeBytes(paths.font(font.id, ext), bytes)
      registerCustomFont(font, bytes)
      const fonts = [...get().customFonts, font]
      set({ customFonts: fonts })
      await writeJSON(paths.fonts, fonts)
      get().showToast(tr('已添加字体：{name}', { name: font.name }))
    },

    async removeFont(id) {
      const font = get().customFonts.find(f => f.id === id)
      if (!font) return
      unregisterCustomFont(id)
      await removeFile(paths.font(id, font.ext)).catch(() => {})
      const fonts = get().customFonts.filter(f => f.id !== id)
      set({ customFonts: fonts })
      await writeJSON(paths.fonts, fonts)
      get().updateSettings(st => ({
        ...st,
        uiFont: st.uiFont === `custom:${id}` ? 'anthropic-sans' : st.uiFont,
        reading: { ...st.reading, font: st.reading.font === `custom:${id}` ? 'anthropic-serif' : st.reading.font },
      }))
    },

    openReader(hash) {
      // 合上书：先把最后的进度和阅读时长记下来，书架显示出来时就是最新的
      if (!hash && get().reading) runBeforeLeave()
      set({ reading: hash })
      markSession(hash)
      // 退出阅读：把阅读期间推迟的重活（书籍文件传输、文件夹扫描）补上
      if (!hash && deferredHeavy) {
        deferredHeavy = false
        setTimeout(() => {
          if (get().reading) return
          get().runSync()
          get().scanFolders()
        }, 1500)
      }
    },

    showToast(msg) {
      set({ toast: msg })
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => set({ toast: null }), 2600)
    },
  }
})

const zhCompare = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare

export const visibleBooks = (lib: BookRecord[], sort: ShelfSort = 'recent') => {
  const recent = (a: BookRecord, b: BookRecord) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt)
  const by: Record<ShelfSort, (a: BookRecord, b: BookRecord) => number> = {
    recent,
    added: (a, b) => b.addedAt - a.addedAt,
    title: (a, b) => zhCompare(a.title, b.title),
    author: (a, b) => zhCompare(a.author || '￿', b.author || '￿') || zhCompare(a.title, b.title),
    progress: (a, b) => (b.progress?.fraction ?? -1) - (a.progress?.fraction ?? -1) || recent(a, b),
  }
  return lib.filter(b => !b.deletedAt).sort(by[sort] ?? recent)
}

/** 没被删除的分类，按顺序排好 */
export const liveCategories = (list: Category[]) => list.filter(c => !c.deleted).sort((a, b) => a.order - b.order || a.updatedAt - b.updatedAt)

/**
 * 阅读时书架、统计等页面保持挂载但不更新：阅读期间选择器一直返回进书前的那份数据，
 * 翻页保存进度不会让上百本书跟着重新计算；合上书的那一刻再一次性换成最新数据。
 */
export function useShelf<T>(selector: (s: State) => T): T {
  const last = useRef<{ v: T } | null>(null)
  const v = useStore(s => (s.reading && last.current ? last.current.v : selector(s)))
  last.current = { v }
  return v
}
