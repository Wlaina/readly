/**
 * 应用内更新（GitHub Releases：Wlaina/readly）
 * - Windows：Tauri 官方更新插件。下载安装包、校验签名，然后静默覆盖安装并自动重启。
 * - 安卓：读取同一份 latest.json，比较版本号，下载 APK 后调起系统安装。
 * 状态放在一个小 store 里，设置页和书架上的更新提示共用。
 */
import { create } from 'zustand'
import { isTauri } from './storage'
import { androidBridge, isWindowsApp } from './native'
import { isAndroid } from './device'

export const RELEASES_PAGE = 'https://github.com/Wlaina/readly/releases'
/**
 * 更新清单的地址：按顺序尝试，前一个取不到（网络问题、地址失效）才用下一个。
 * 0.8.3 起安装包和源码合并到 Wlaina/readly（旧的安装包仓库已删除）。
 */
const LATEST_JSON = [
  'https://github.com/Wlaina/readly/releases/latest/download/latest.json',
]
const LAST_CHECK_KEY = 'readly.update.lastCheck'

type Status = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'installing' | 'error'
interface UpdateState {
  status: Status
  current: string
  version: string
  notes: string
  progress: number
  error: string
  /** 书架上的提示被关掉了（本次运行不再弹） */
  dismissed: boolean
}
export const useUpdate = create<UpdateState>(() => ({
  status: 'idle',
  current: '',
  version: '',
  notes: '',
  progress: 0,
  error: '',
  dismissed: false,
}))

export const updateSupported = isTauri && (isWindowsApp || isAndroid)

/** 语义化版本比较：a > b 返回正数 */
function cmp(a: string, b: string) {
  const pa = a.replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

// 待安装的更新（Windows 是插件返回的对象，安卓是 APK 地址）
let pendingWin: { downloadAndInstall: (cb: (e: any) => void) => Promise<void> } | null = null
let pendingApk = ''

async function currentVersion() {
  const { getVersion } = await import('@tauri-apps/api/app')
  return getVersion()
}

/** 检查更新。silent=true 时出错不打扰（启动时的自动检查） */
export async function checkForUpdate(silent = false) {
  if (!updateSupported) return
  const set = useUpdate.setState
  if (['checking', 'downloading', 'installing'].includes(useUpdate.getState().status)) return
  set({ status: 'checking', error: '' })
  try {
    const current = await currentVersion()
    set({ current })
    if (isWindowsApp) {
      const { check } = await import('@tauri-apps/plugin-updater')
      const u = await check({ timeout: 20000 })
      pendingWin = u
      if (!u) return set({ status: 'none' })
      set({ status: 'available', version: u.version, notes: u.body ?? '' })
    } else {
      const { fetch } = await import('@tauri-apps/plugin-http')
      let info: any = null
      let lastErr: unknown = null
      for (const src of LATEST_JSON) {
        try {
          const res = await fetch(`${src}?t=${Date.now()}`, { method: 'GET', connectTimeout: 20000 } as RequestInit)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          info = await res.json()
          break
        } catch (e) {
          lastErr = e
        }
      }
      if (!info) throw lastErr ?? new Error('no update info')
      const url: string | undefined = info?.platforms?.['android-aarch64']?.url
      if (!url || cmp(info.version, current) <= 0) return set({ status: 'none' })
      pendingApk = url
      set({ status: 'available', version: String(info.version).replace(/^v/, ''), notes: info.notes ?? '' })
    }
  } catch (e) {
    console.warn('检查更新失败', e)
    set({ status: silent ? 'idle' : 'error', error: e instanceof Error ? e.message : String(e) })
  } finally {
    try {
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()))
    } catch {
      /* 忽略 */
    }
  }
}

/** 启动后的自动检查：距离上次检查超过 12 小时才查，不打扰 */
export function autoCheck() {
  if (!updateSupported) return
  let last = 0
  try {
    last = Number(localStorage.getItem(LAST_CHECK_KEY)) || 0
  } catch {
    /* 忽略 */
  }
  if (Date.now() - last < 12 * 3600_000) return
  setTimeout(() => checkForUpdate(true), 6000)
}

/** 下载并安装。Windows 安装完成后会自动关闭并重启 Readly；安卓会弹出系统安装界面 */
export async function installUpdate() {
  const set = useUpdate.setState
  set({ status: 'downloading', progress: 0, error: '' })
  try {
    if (isWindowsApp) {
      if (!pendingWin) throw new Error('no update')
      let total = 0
      let got = 0
      await pendingWin.downloadAndInstall(ev => {
        if (ev.event === 'Started') total = ev.data.contentLength ?? 0
        else if (ev.event === 'Progress') {
          got += ev.data.chunkLength
          if (total) set({ progress: got / total })
        } else if (ev.event === 'Finished') set({ status: 'installing', progress: 1 })
      })
      // 正常情况下到这里应用已被安装程序关闭
    } else {
      const bridge = androidBridge()
      if (!pendingApk || !bridge?.downloadAndInstall) throw new Error('no update')
      await new Promise<void>((resolve, reject) => {
        ;(window as any).__readlyUpdateProgress = (p: number, err: string) => {
          if (p < 0) {
            delete (window as any).__readlyUpdateProgress
            reject(new Error(err || 'download failed'))
          } else if (p >= 1) {
            set({ status: 'installing', progress: 1 })
            delete (window as any).__readlyUpdateProgress
            resolve()
          } else set({ progress: p })
        }
        bridge.downloadAndInstall!(pendingApk)
      })
      // 系统安装界面已弹出；回到这里时恢复为可再次安装
      setTimeout(() => set({ status: 'available' }), 4000)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    set({ status: msg === 'need-permission' ? 'available' : 'error', error: msg })
  }
}
