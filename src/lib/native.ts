/**
 * 与 Rust 端的桥：处理“用 Readly 打开”传进来的文件。
 * Windows：首次启动从命令行参数读取，已运行时由 single-instance 插件转发。
 */
import { isTauri } from './storage'

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p

export async function takePendingOpenFiles(): Promise<string[]> {
  if (!isTauri) return []
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string[]>('take_open_files')
}

export async function onOpenFiles(cb: (paths: string[]) => void) {
  if (!isTauri) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<string[]>('open-files', e => cb(e.payload))
}

export const isWindowsApp = isTauri && navigator.userAgent.includes('Windows')

/**
 * 把修改后的书写回书籍文件夹里的原文件（仅电脑端）。
 * 二进制直接作为请求体传给 Rust，路径放在请求头里，避免大文件走 JSON。
 * 返回写入后的文件信息，用来让下次扫描认出“这是 Readly 自己写的”。
 */
export async function writeFolderFile(root: string, rel: string, bytes: Uint8Array) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<{ rel: string; size: number; mtime: number }>('write_folder_file', bytes, {
    headers: { 'x-root': encodeURIComponent(root), 'x-rel': encodeURIComponent(rel) },
  })
}

/** 全屏开关：Tauri 用窗口全屏，浏览器用 Fullscreen API。返回切换后的状态 */
export async function toggleFullscreen(): Promise<boolean> {
  if (isTauri) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const w = getCurrentWindow()
    const next = !(await w.isFullscreen())
    await w.setFullscreen(next)
    return next
  }
  if (document.fullscreenElement) {
    await document.exitFullscreen()
    return false
  }
  await document.documentElement.requestFullscreen()
  return true
}

/* ---------- 安卓原生桥（MainActivity 注入的 ReadlyAndroid） ---------- */
interface AndroidBridge {
  setImmersive(on: boolean): void
  setSystemBarsDark(dark: boolean): void
  isSystemDark?(): boolean
  setKeepScreenOn?(on: boolean): void
}
const android = (): AndroidBridge | undefined => (window as any).ReadlyAndroid

/** 阅读时隐藏状态栏与底部手势条（上滑边缘可临时唤出） */
export function setImmersive(on: boolean) {
  try {
    android()?.setImmersive(on)
  } catch (e) {
    console.warn(e)
  }
}

/** 让系统栏图标颜色跟随深浅色 */
export function setSystemBarsDark(dark: boolean) {
  try {
    android()?.setSystemBarsDark(dark)
  } catch (e) {
    console.warn(e)
  }
}

/** 便携版：把 Readly 加入/移出 .epub、.txt 的“打开方式” */
export async function setOpenWith(enable: boolean) {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('set_open_with', { enable })
}

export async function readOpenedFile(path: string): Promise<File> {
  const { invoke } = await import('@tauri-apps/api/core')
  const buf = await invoke<ArrayBuffer>('read_open_file', { path })
  return new File([buf], basename(path))
}

/**
 * Windows：在资源管理器中显示这本书的文件。
 * 来自“书籍文件夹”的书优先定位到文件夹里的原文件，否则定位到 Readly 数据目录里保存的副本。
 */
export async function revealBook(rec: { hash: string; format: string; folderRef?: { folderId: string; rel: string } }, folderPath?: string) {
  const { invoke } = await import('@tauri-apps/api/core')
  const { appDataDir, join } = await import('@tauri-apps/api/path')
  const target =
    folderPath && rec.folderRef ? await join(folderPath, ...rec.folderRef.rel.split('/')) : await join(await appDataDir(), 'books', `${rec.hash}.${rec.format}`)
  await invoke('reveal_path', { path: target })
}

/** 安卓：直接向系统查询是否为深色模式；不支持时返回 null */
export function nativeSystemDark(): boolean | null {
  try {
    const v = android()?.isSystemDark?.()
    return typeof v === 'boolean' ? v : null
  } catch {
    return null
  }
}

/** 触感反馈开关（设置里可关） */
let hapticsOn = true
export const setHaptics = (on: boolean) => (hapticsOn = on)
export function haptic(ms = 10) {
  if (hapticsOn) navigator.vibrate?.(ms)
}

/** 阅读时保持屏幕常亮（安卓；其他平台忽略） */
export function setKeepScreenOn(on: boolean) {
  try {
    android()?.setKeepScreenOn?.(on)
  } catch (e) {
    console.warn(e)
  }
}

/* ---------- 安卓原生桥：音量键、分享、加密、应用内更新 ---------- */
type Bridge2 = {
  openUrl?(url: string): void
  setVolumeKeys?(on: boolean): void
  shareFile?(path: string, mime: string, title: string): void
  protectSecret?(plain: string): string
  unprotectSecret?(cipher: string): string
  downloadAndInstall?(url: string): void
  backgroundPut?(url: string, auth: string, json: string): boolean
  setBrightness?(v: number): void
  getExitReasons?(): string
  takeRendererGone?(): string
}
const bridge2 = (): Bridge2 | undefined => (window as any).ReadlyAndroid

export function setVolumeKeys(on: boolean) {
  try {
    bridge2()?.setVolumeKeys?.(on)
  } catch (e) {
    console.warn(e)
  }
}

/**
 * 安卓：把本机阅读记录交给原生线程压缩并上传（切到后台时用，网页被系统暂停也能传完）。
 * 返回 true 表示原生端已接手；其他平台返回 false，由调用方走普通上传。
 */
export function backgroundPut(url: string, auth: string, json: string): boolean {
  try {
    return bridge2()?.backgroundPut?.(url, auth, json) === true
  } catch (e) {
    console.warn('后台上传失败', e)
    return false
  }
}

/** 安卓能否直接调节屏幕亮度（只影响 Readly 自己的窗口）；其他平台用遮罩调暗 */
export const hasNativeBrightness = () => typeof bridge2()?.setBrightness === 'function'

/** 设置窗口亮度：0.02 ~ 1；传 -1 恢复跟随系统 */
export function setNativeBrightness(v: number) {
  try {
    bridge2()?.setBrightness?.(v)
  } catch (e) {
    console.warn(e)
  }
}

const EXIT_REASON: Record<number, string> = {
  1: '应用自己退出',
  2: '被信号杀掉',
  3: '系统内存不足被回收',
  4: '崩溃（Java）',
  5: '崩溃（原生）',
  6: '无响应（ANR）',
  7: '初始化失败',
  8: '权限变更',
  9: '占用资源过多被系统结束',
  10: '用户或系统主动结束',
  11: '被用户强行停止',
  12: '依赖的进程挂了',
  13: '其他',
  14: '被冻结',
  15: '应用状态变更',
  16: '应用更新',
}

/** 上一次网页渲染进程退出的记录（原生侧接管后记下的；取一次就清掉） */
export function rendererGone(): string | null {
  try {
    const raw = bridge2()?.takeRendererGone?.()
    if (!raw) return null
    const r = JSON.parse(raw) as { time: number; crashed: boolean; priority: number; foreground: boolean }
    return `${new Date(r.time).toISOString()} ${r.crashed ? '崩溃' : '被系统回收'}（${r.foreground ? '在前台，已自动重启' : '在后台'}，优先级 ${r.priority}）`
  } catch {
    return null
  }
}

/** 安卓 11+：最近几次进程是怎么结束的（给诊断日志用）；取不到时返回空数组 */
export function exitReasons(): string[] {
  try {
    const raw = bridge2()?.getExitReasons?.()
    if (!raw) return []
    const list = JSON.parse(raw) as { time: number; reason: number; status: number; importance: number; process: string; desc: string; rssKb: number }[]
    return list.map(
      x =>
        `${new Date(x.time).toISOString()} ${x.process.split(':').pop() ?? ''} ${EXIT_REASON[x.reason] ?? `原因 ${x.reason}`}` +
        `（status ${x.status}，importance ${x.importance}，内存 ${Math.round(x.rssKb / 1024)}MB${x.desc ? `，${x.desc}` : ''}）`,
    )
  } catch {
    return []
  }
}

export function shareFile(path: string, mime: string, title: string) {
  bridge2()?.shareFile?.(path, mime, title)
}

export const androidBridge = bridge2

/** 用系统默认浏览器打开网址：Windows 走 Rust，安卓走原生桥，浏览器开发模式直接新开标签页 */
export async function openUrl(url: string) {
  if (!/^https?:\/\//.test(url)) return
  if (isWindowsApp) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_url', { url })
  } else if (bridge2()?.openUrl) bridge2()!.openUrl!(url)
  else window.open(url, '_blank', 'noopener')
}
