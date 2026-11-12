/**
 * 诊断日志：记录运行中的警告、错误和关键事件，出问题时一键导出发给开发者分析。
 * - 只在内存里保留最近 1500 条，并定期写入应用数据目录（重启后仍能看到上次的问题）
 * - 导出时附上设备、版本、设置摘要；WebDAV 密码、账号等敏感信息一律不导出
 */
import { readBytes, writeBytes, isTauri } from './storage'
import { exitReasons, isWindowsApp, rendererGone, shareFile } from './native'

interface Entry {
  t: number
  level: 'log' | 'info' | 'warn' | 'error'
  msg: string
}

const MAX = 1500
const FILE = 'logs/diag.json'
let entries: Entry[] = []
let dirty = false

const fmt = (a: unknown): string => {
  if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack.split('\n').slice(1, 5).join('\n')}` : ''}`
  if (typeof a === 'string') return a
  try {
    return JSON.stringify(a)?.slice(0, 600) ?? String(a)
  } catch {
    return String(a)
  }
}

/** 去掉日志里可能出现的敏感信息 */
const scrub = (s: string) =>
  s
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/g, '$1***')
    .replace(/("?password"?\s*[:=]\s*)"[^"]*"/gi, '$1"***"')
    .replace(/(https?:\/\/)[^/@\s]+@/g, '$1***@')

/** 连续重复的同一条消息只记一次并计数（某些报错会每帧来一条，几秒钟就把整份日志冲掉） */
let repeat = 0
export function diag(level: Entry['level'], ...args: unknown[]) {
  const msg = scrub(args.map(fmt).join(' ')).slice(0, 2000)
  const last = entries[entries.length - 1]
  const base = last?.msg.replace(/ （连续 \d+ 次，持续 [\d.]+ 秒）$/, '')
  if (last && last.level === level && base === msg) {
    repeat++
    last.msg = `${msg} （连续 ${repeat + 1} 次，持续 ${((Date.now() - last.t) / 1000).toFixed(1)} 秒）`
    dirty = true
    return
  }
  repeat = 0
  entries.push({ t: Date.now(), level, msg })
  if (entries.length > MAX) entries = entries.slice(-MAX)
  dirty = true
}

let installed = false

/**
 * 记下每个 ResizeObserver 是在哪里创建的、回调了多少次。
 * 真机上出现过每帧一条、持续一分多钟的 “ResizeObserver loop” 报错，预览里复现不了；
 * 下次再出现时，日志会写明是哪一个监听在循环。
 */
const roCounts = new Map<string, number>()
function instrumentResizeObserver() {
  const Orig = window.ResizeObserver
  if (!Orig) return
  window.ResizeObserver = class extends Orig {
    constructor(cb: ResizeObserverCallback) {
      const where =
        (new Error().stack ?? '')
          .split('\n')
          .slice(2, 4)
          .map(l => l.trim().replace(/^at /, '').replace(/\?t=\d+/, '').replace(/https?:\/\/[^/]+/, ''))
          .join(' ← ') || '未知'
      super((entries, obs) => {
        roCounts.set(where, (roCounts.get(where) ?? 0) + 1)
        cb(entries, obs)
      })
    }
  }
  let loops = 0
  let windowStart = 0
  let reported = 0
  window.addEventListener('error', e => {
    if (!/ResizeObserver loop/.test(e.message)) return
    const now = Date.now()
    if (now - windowStart > 1000) {
      windowStart = now
      loops = 0
    }
    // 一秒里出现 20 次以上、而且距上次报告超过 30 秒：把各个监听的回调次数记下来
    if (++loops === 20 && now - reported > 30_000) {
      reported = now
      const top = [...roCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      diag('warn', `ResizeObserver 循环，各监听回调次数：${top.map(([k, v]) => `${v} 次 @ ${k}`).join('；')}`)
      roCounts.clear()
    }
  })
}

export function installDiagnostics() {
  if (installed) return
  installed = true
  try {
    instrumentResizeObserver()
  } catch {
    /* 不影响正常使用 */
  }
  for (const level of ['warn', 'error', 'info'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      diag(level, ...args)
      orig(...args)
    }
  }
  window.addEventListener('error', e => diag('error', `未捕获的错误：${e.message}`, `${e.filename}:${e.lineno}`))
  window.addEventListener('unhandledrejection', e => diag('error', '未处理的 Promise 异常：', e.reason))
  let hiddenAt = 0
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      diag('log', '页面进入后台')
      flush()
      return
    }
    // 回到前台：量一下接下来 1 秒里最长的一帧。闪烁、卡顿时这里会留下证据
    const away = hiddenAt ? ((Date.now() - hiddenAt) / 1000).toFixed(0) : '?'
    const t0 = performance.now()
    let prev = t0
    let worst = 0
    let frames = 0
    const step = (now: number) => {
      worst = Math.max(worst, now - prev)
      prev = now
      frames++
      if (now - t0 < 1000) requestAnimationFrame(step)
      else diag('log', `页面回到前台（离开 ${away} 秒）：1 秒内 ${frames} 帧，最长一帧 ${worst.toFixed(0)}ms`)
    }
    requestAnimationFrame(step)
  })
  // 读入上次运行留下的记录
  readBytes(FILE)
    .then(b => {
      if (!b) return
      const old: Entry[] = JSON.parse(new TextDecoder().decode(b))
      entries = [...old.slice(-(MAX / 2)), { t: Date.now(), level: 'info' as const, msg: '—— 本次启动 ——' }, ...entries].slice(-MAX)
    })
    .catch(() => {})
  setInterval(flush, 30_000)
  diag('info', `启动 · ${navigator.userAgent}`)
  // 上一次是怎么退出的（崩溃？被系统回收？）：排查“突然回到桌面”用
  const exits = exitReasons()
  if (exits.length) diag('info', `最近的进程退出记录：\n${exits.join('\n')}`)
  const gone = rendererGone()
  if (gone) diag('warn', `上次网页渲染进程退出：${gone}`)
}

function flush() {
  if (!dirty) return
  dirty = false
  writeBytes(FILE, new TextEncoder().encode(JSON.stringify(entries))).catch(() => {})
}

/** 生成报告文本；extra 由调用方提供（设置摘要、书架统计等，已去掉敏感信息） */
export function buildReport(extra: Record<string, unknown>) {
  const lines = [
    'Readly 诊断报告',
    `生成时间：${new Date().toLocaleString()}`,
    `UA：${navigator.userAgent}`,
    `屏幕：${screen.width}×${screen.height} @${devicePixelRatio}x，窗口 ${innerWidth}×${innerHeight}`,
    '',
    '## 概况',
    ...Object.entries(extra).map(([k, v]) => `${k}：${typeof v === 'string' ? v : JSON.stringify(v)}`),
    '',
    `## 日志（最近 ${entries.length} 条）`,
    ...entries.map(e => `${new Date(e.t).toISOString()} [${e.level.toUpperCase()}] ${e.msg}`),
  ]
  return scrub(lines.join('\n'))
}

/** 导出：Windows 弹出“另存为”；安卓调起系统分享（可发到微信/QQ，或保存到文件） */
export async function exportReport(text: string): Promise<'saved' | 'shared' | 'cancelled' | 'copied'> {
  const name = `readly-diag-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`
  if (isWindowsApp) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({ defaultPath: name, filters: [{ name: 'Text', extensions: ['txt'] }] })
    if (!path) return 'cancelled'
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('write_text_file', { path, text })
    return 'saved'
  }
  if (isTauri) {
    // 安卓：先写到缓存目录，再交给系统分享
    const { writeFile, BaseDirectory } = await import('@tauri-apps/plugin-fs')
    const { appCacheDir, join } = await import('@tauri-apps/api/path')
    await writeFile(name, new TextEncoder().encode(text), { baseDir: BaseDirectory.AppCache })
    shareFile(await join(await appCacheDir(), name), 'text/plain', name)
    return 'shared'
  }
  await navigator.clipboard.writeText(text)
  return 'copied'
}
