/**
 * 书源网页抓取：交给“隐藏浏览器”真正打开网页（能通过 Cloudflare、能执行网页自己的脚本），
 * 取回整页 HTML 后在这里用 DOMParser 解析。
 * 电脑端：Rust 的 browser_load（隐藏的 WebView2 窗口）；安卓端：MainActivity 的 SourceBrowser（系统 WebView）。
 */
import { isTauri } from '../storage'
import { isAndroid } from '../device'

export interface LoadedPage {
  url: string
  doc: Document
  /** extract 表达式在网页里的求值结果 */
  data: unknown
}

const bridge = () => (window as any).ReadlyAndroid
export const browserSupported = isTauri && (!isAndroid || !!bridge()?.browserLoad)

/** 同时最多几个隐藏网页（下载时并行抓几章）；与 Rust / Kotlin 里的 SLOTS 一致 */
export const BROWSER_SLOTS = 3

/**
 * 页面状态探测脚本（安卓端用；电脑端在 Rust 里有同样的一份，两边要一起改）：
 * OLD 还是上一页 / LOADING / CHALLENGE 人机验证 / WAIT 等元素出现或内容稳定 / OK:{url,html,data}
 * 内容稳定：目标元素连续两次一样才读；但最多等 1.5 秒（页面上有轮播广告时内容会一直变）
 */
function probe(selector: string, extract: string, noHtml: boolean, waitAll: boolean) {
  // 默认网页结构出来（interactive）就读，不等广告、图片全部加载完；验证码这类要看图的页面才等 complete
  return `(function(){try{
  if (window.__readlyOld) return 'OLD';
  if (${waitAll ? "document.readyState !== 'complete'" : "document.readyState === 'loading'"}) return 'LOADING';
  var t = document.title || '';
  if (document.querySelector('#challenge-form,#cf-challenge-running,.cf-turnstile,[id^="cf-chl-"],#challenge-stage') || /Just a moment|请稍候|Attention Required/i.test(t)) return 'CHALLENGE';
  // 网站限流 / 拒绝访问：立刻报错（由下载那边稍等再重试），不要傻等到超时
  if (/Access denied|Too Many Requests|Error 10[0-9][0-9]|访问过于频繁|请求过于频繁/i.test(t)) return 'BLOCKED:' + t.slice(0, 60);
  var sel = ${JSON.stringify(selector)};
  var box = sel ? document.querySelector(sel) : document.body;
  if (!box) { window.__readlyFound = 0; return 'WAIT:' + location.host + ' ' + t.slice(0, 40); }
  var now = Date.now();
  if (!window.__readlyFound) window.__readlyFound = now;
  var sig = box.innerHTML.length;
  if (window.__readlySig !== sig && now - window.__readlyFound < 1500) { window.__readlySig = sig; return 'WAIT'; }
  var data = null;
  try { data = (${extract || 'null'}); } catch (e) { data = { error: String(e) }; }
  return 'OK:' + JSON.stringify({ url: location.href, html: ${noHtml ? "''" : 'document.documentElement.outerHTML'}, data: data });
}catch(e){return 'ERR:' + e}})()`
}

let seq = 0
const waiting = new Map<string, (raw: string) => void>()

function androidLoad(url: string, script: string, timeoutMs: number, desktop: boolean, action: string, images: boolean, slot: number): Promise<string> {
  const b = bridge()
  ;(window as any).__readlyBrowserDone ??= (id: string) => {
    const done = waiting.get(id)
    waiting.delete(id)
    done?.(b.browserTake(id))
  }
  const id = `b${++seq}`
  return new Promise(resolve => {
    // 保险：原生那边万一没回结果，也不能让下载永远卡在这一页
    const guard = setTimeout(() => {
      if (waiting.delete(id)) resolve('ERR:网页加载超时')
    }, timeoutMs + 60_000)
    waiting.set(id, raw => {
      clearTimeout(guard)
      resolve(raw)
    })
    b.browserLoad(id, url, script, timeoutMs, desktop, action, images, slot)
  })
}

export interface LoadOptions {
  /** 等这个元素出现（且内容不再变化）才算加载完 */
  selector?: string
  /** 在网页里求值的表达式，结果放在 data 里 */
  extract?: string
  timeoutMs?: number
  /** 安卓上用电脑版浏览器标识（有的网站会把手机跳到结构不同的手机版） */
  desktop?: boolean
  /** 不打开 url，而是在当前页面里执行这段脚本（例如填验证码后提交表单），再等新页面 */
  action?: string
  /** 安卓上加载网页里的图片（默认不加载；验证码页需要） */
  images?: boolean
  /** 用第几个隐藏网页（0 ~ BROWSER_SLOTS-1）；搜索、登录用 0，下载时并行用不同的 */
  slot?: number
  /** 取消：立刻放弃等待（隐藏网页里正在加载的那一页由 cancelBrowser 一起停掉） */
  signal?: AbortSignal
  /** 不取回整页 HTML（只要 extract 的结果）：几百 KB 的网页不用再传过来、再解析一遍，下载时主界面不卡 */
  noHtml?: boolean
  /** 等网页里所有资源（图片等）都加载完再读，例如验证码图片 */
  waitAll?: boolean
}

/** 打开网页，等页面就绪后返回解析好的文档 */
export async function loadPage(url: string, o: LoadOptions = {}): Promise<LoadedPage> {
  try {
    return await loadPageOnce(url, o)
  } catch (e) {
    // 超时（例如刚启动时第一次创建隐藏网页）自动再试一次；提交表单这类操作不能重复做
    if (o.action || o.signal?.aborted || !/超时/.test(String((e as Error)?.message ?? e))) throw e
    return loadPageOnce(url, o)
  }
}

/**
 * 按网站限速：两次打开网页之间至少隔多久（所有隐藏网页合计）。
 * 轻小说文库请求太密会整段时间回“Access denied”（参考 bili_novel_packer：每分钟 20 次）。
 */
const MIN_GAP: [RegExp, number][] = [
  [/wenku8\./, 3000],
  [/linovelib\.|bilinovel\./, 700],
]
const nextAt = new Map<RegExp, number>()
async function rateLimit(url: string, signal?: AbortSignal) {
  const rule = MIN_GAP.find(([re]) => re.test(url))
  if (!rule) return
  const [re, gap] = rule
  const now = Date.now()
  const at = Math.max(now, nextAt.get(re) ?? 0)
  nextAt.set(re, at + gap)
  if (at > now) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, at - now)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          reject(new DOMException('cancelled', 'AbortError'))
        },
        { once: true },
      )
    })
  }
}

async function loadPageOnce(url: string, o: LoadOptions): Promise<LoadedPage> {
  if (!browserSupported) throw new Error('当前平台暂不支持书源')
  if (!/^https?:\/\//.test(url)) throw new Error(`不是网页地址：${url}`)
  // 提交表单（验证码）也算一次请求
  await rateLimit(o.action ? 'https://www.bilinovel.com/' : url, o.signal)
  const timeoutMs = o.timeoutMs ?? 30_000
  const slot = Math.max(0, Math.min(BROWSER_SLOTS - 1, o.slot ?? 0))
  if (o.signal?.aborted) throw new DOMException('cancelled', 'AbortError')
  const work = (async () => {
    if (isAndroid) {
      const raw = await androidLoad(
        url,
        probe(o.selector ?? '', o.extract ?? '', !!o.noHtml, !!o.waitAll),
        timeoutMs,
        !!o.desktop,
        o.action ?? '',
        !!o.images,
        slot,
      )
      if (!raw.startsWith('OK:')) throw new Error(raw.replace(/^ERR:/, '') || '网页加载失败')
      return JSON.parse(raw.slice(3)) as {
        url: string
        html: string
        data: unknown
      }
    }
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<{ url: string; html: string; data: unknown }>('browser_load', {
      url,
      selector: o.selector ?? null,
      extract: o.extract ?? null,
      timeoutMs,
      action: o.action ?? null,
      slot,
      noHtml: !!o.noHtml,
      waitAll: !!o.waitAll,
    })
  })()
  const r = o.signal
    ? await Promise.race([
        work,
        new Promise<never>((_, reject) => o.signal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })),
      ])
    : await work
  const doc = r.html ? new DOMParser().parseFromString(r.html, 'text/html') : document.implementation.createHTMLDocument('')
  // 让相对地址按网页的真实地址解析
  const base = doc.createElement('base')
  base.href = r.url
  doc.head.prepend(base)
  return { url: r.url, doc, data: r.data }
}

/** 显示书源网页窗口（登录 / 手动完成人机验证）；autoClose：登录完成、跳离登录页后自动收起 */
export async function showBrowser(url: string, autoClose = false) {
  if (isAndroid) return bridge()?.browserShow(url, autoClose)
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('browser_show', { url, autoClose })
}

/** 书源网页窗口被收起时（用户登录完、关掉窗口）回调一次；返回取消函数 */
export function onBrowserHidden(cb: () => void): () => void {
  if (isAndroid) {
    ;(window as any).__readlyBrowserHidden = cb
    return () => {
      if ((window as any).__readlyBrowserHidden === cb) delete (window as any).__readlyBrowserHidden
    }
  }
  let off: (() => void) | null = null
  let dead = false
  import('@tauri-apps/api/event').then(({ listen }) => listen('browser-hidden', () => cb()).then(u => (dead ? u() : (off = u))))
  return () => {
    dead = true
    off?.()
  }
}

/** 停掉所有隐藏网页里正在加载和排队的页面 */
export async function cancelBrowser() {
  if (!browserSupported) return
  if (isAndroid) return bridge()?.browserCancel?.()
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('browser_cancel')
}

export async function hideBrowser() {
  if (isAndroid) return bridge()?.browserHide()
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('browser_hide')
}

export const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
export const abs = (doc: Document, href: string | null | undefined) => (href ? new URL(href, doc.baseURI).href : '')
