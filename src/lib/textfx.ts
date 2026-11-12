/**
 * 打开书时的文字特效（只在刚打开、第一屏显示出来的时候播放一次）：
 * - emerge 文字浮现：一个个字带着一团微光，从空白的纸上按阅读顺序缓缓显现
 * - runes  符文飞入：每个字像魔法符文一样，从四周旋转着飞到自己的位置，带着光晕落定
 *
 * 做法：书页先保持隐藏；把屏幕上（所有可见的栏、所有可见的章节）每个字的确切位置量出来，
 * 然后在书页上方的**一张画布**上逐帧画这些字。整场动画只有一个图层：
 * 以前每个字一个元素、一个图层、还带着逐帧变化的发光阴影，字一多（尤其最后大家一起落定时）就卡。
 * 最后一帧每个字都正好画在它在书页上的位置，书页一显示、画布一撤，看不出交接。
 * 书本身的内容完全不改动，划词、书签、进度都不受影响。
 */
import { motionScale } from './motion'

export type TextFx = 'emerge' | 'runes'

interface Glyph {
  ch: string
  /** 字在屏幕上的盒子（CSS 像素） */
  x: number
  y: number
  w: number
  h: number
  /** 基线相对盒子顶部的距离 */
  base: number
  font: string
  color: string
  // 动画参数
  delay: number
  dur: number
  fromX: number
  fromY: number
  rot: number
}

/** 一屏最多处理这么多字（电脑大窗口双栏也够用；再多就退回普通淡入） */
const MAX_GLYPHS = 2600

/** 某个字体的上沿（基线以上的高度）；同一字体只量一次 */
const ascents = new Map<string, number>()
function ascentOf(ctx: CanvasRenderingContext2D, font: string, h: number) {
  let a = ascents.get(font)
  if (a == null) {
    ctx.font = font
    const m = ctx.measureText('国Hg')
    a = m.fontBoundingBoxAscent && m.fontBoundingBoxDescent ? m.fontBoundingBoxAscent : NaN
    ascents.set(font, a)
  }
  // 量不到（极老的内核）时按常见比例估一个
  return Number.isFinite(a) ? a : h * 0.8
}

/** 量出所有可见章节里、落在屏幕内的每个字的位置 */
function collect(docs: Document[], ctx: CanvasRenderingContext2D): Glyph[] | null {
  const W = window.innerWidth
  const H = window.innerHeight
  const out: Glyph[] = []
  // 文档里的先后就是阅读顺序（分栏排版时也是先左栏后右栏）；几个章节同屏时按它们在屏幕上的左右排
  const ordered = docs
    .map(doc => ({ doc, left: (doc.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect().left ?? 0 }))
    .sort((a, b) => a.left - b.left)
    .map(x => x.doc)
  for (const doc of ordered) {
    const win = doc.defaultView
    const frame = win?.frameElement as HTMLElement | null
    if (!win || !frame || !doc.body) continue
    const fr = frame.getBoundingClientRect()
    // 整个章节都不在屏幕上（预加载的前后章节）：直接跳过
    if (fr.right < 0 || fr.left > W || fr.bottom < 0 || fr.top > H) continue
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    const probe = doc.createRange()
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const node = n as Text
      const text = node.data
      if (!text.trim()) continue
      // 先看整段文字在不在屏幕上，不在就不逐字量（一章可能有几万个字）
      probe.selectNodeContents(node)
      const nr = probe.getBoundingClientRect()
      if (fr.left + nr.right < 0 || fr.left + nr.left > W || fr.top + nr.bottom < 0 || fr.top + nr.top > H) continue
      const parent = node.parentElement
      if (!parent) continue
      const cs = win.getComputedStyle(parent)
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue
      const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const color = cs.color
      for (let i = 0; i < text.length; i++) {
        let ch = text[i]
        // 代理对（生僻字、表情）占两个位置，要一起量
        const code = text.charCodeAt(i)
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) ch = text.slice(i, i + 2)
        const len = ch.length
        if (/\s/.test(ch)) continue
        probe.setStart(node, i)
        probe.setEnd(node, i + len)
        i += len - 1
        const r = probe.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) continue
        const x = fr.left + r.left
        const y = fr.top + r.top
        if (x + r.width < 0 || x > W || y + r.height < 0 || y > H) continue
        out.push({ ch, x, y, w: r.width, h: r.height, base: ascentOf(ctx, font, r.height), font, color, delay: 0, dur: 0, fromX: 0, fromY: 0, rot: 0 })
        if (out.length > MAX_GLYPHS) return null
      }
    }
  }
  return out
}

/** 光晕：一张小小的径向渐变图，画在每个字后面（放大缩小都很便宜，不用逐帧算阴影模糊） */
function makeOrb(color: string) {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, color)
  grad.addColorStop(0.35, color)
  grad.addColorStop(1, 'transparent')
  g.fillStyle = grad
  g.globalAlpha = 0.85
  g.fillRect(0, 0, 64, 64)
  return c
}

const rand = (a: number, b: number) => a + Math.random() * (b - a)
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const easeOut = (t: number) => 1 - (1 - t) ** 3
const easeOutBack = (t: number) => {
  const c = 1.4
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2
}

/**
 * 播放文字特效。layer 是放画布的容器（盖在书页上、不挡点击）；返回的 done 在特效结束（或被跳过）时完成。
 * 返回 null 表示这一屏没法做特效（调用方直接显示书页）。
 */
export function playTextFx(kind: TextFx, docs: Document[], layer: HTMLElement, accent: string): { done: Promise<void>; skip: () => void } | null {
  if (!docs.length) return null
  const W = window.innerWidth
  const H = window.innerHeight
  const dpr = Math.min(window.devicePixelRatio || 1, 3)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(W * dpr)
  canvas.height = Math.round(H * dpr)
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  let glyphs: Glyph[] | null
  try {
    glyphs = collect(docs, ctx)
  } catch (e) {
    console.warn('文字特效：量不出字的位置', e)
    return null
  }
  if (!glyphs || glyphs.length < 3) return null

  // 每个字的出场时间、轨迹
  const k = motionScale()
  const n = glyphs.length
  const cx = W / 2
  const cy = H / 2
  let total = 0
  glyphs.forEach((g, i) => {
    const order = i / n
    if (kind === 'emerge') {
      g.dur = 950 * k
      // 按阅读顺序依次显现，带一点随机，像墨水在纸上慢慢渗出来
      g.delay = (order * Math.min(1300, 260 + n * 2.6) + rand(0, 240)) * k
    } else {
      g.dur = 880 * k
      g.delay = (order * 360 + rand(0, 380)) * k
      // 从屏幕中心附近四散的位置出发，转着圈飞向自己的位置
      const ang = rand(0, Math.PI * 2)
      const dist = rand(140, Math.max(200, Math.min(W, H) * 0.55))
      g.fromX = cx + Math.cos(ang) * dist - (g.x + g.w / 2)
      g.fromY = cy + Math.sin(ang) * dist - (g.y + g.h / 2)
      g.rot = (rand(-220, 220) * Math.PI) / 180
    }
    total = Math.max(total, g.delay + g.dur)
  })

  const orb = makeOrb(accent)
  layer.replaceChildren(canvas)
  ctx.textBaseline = 'alphabetic'

  let start = 0
  let raf = 0
  let finished = false
  let resolveDone!: () => void
  const done = new Promise<void>(r => (resolveDone = r))
  const end = () => {
    if (finished) return
    finished = true
    cancelAnimationFrame(raf)
    resolveDone()
  }

  const frame = (now: number) => {
    if (finished) return
    if (!start) start = now
    const t = now - start
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    let font = ''
    let color = ''
    for (const g of glyphs!) {
      const p = clamp01((t - g.delay) / g.dur)
      if (p <= 0) continue
      let ox = 0
      let oy = 0
      let rot = 0
      let scale = 1
      let alpha = 1
      let glow = 0
      if (kind === 'emerge') {
        const e = easeOut(p)
        alpha = e
        oy = (1 - e) * 5
        glow = Math.sin(Math.PI * Math.min(1, p * 1.15)) * 0.55
      } else {
        const e = easeOutBack(Math.min(1, p * 1.05))
        const inv = 1 - Math.min(1, e)
        ox = g.fromX * (1 - e)
        oy = g.fromY * (1 - e)
        rot = g.rot * inv
        scale = 0.35 + 0.65 * e
        alpha = Math.min(1, p * 3.5)
        glow = p < 0.75 ? 0.9 : 0.9 * (1 - (p - 0.75) / 0.25)
      }
      const gx = g.x + g.w / 2 + ox
      const gy = g.y + g.h / 2 + oy
      const c = Math.cos(rot) * scale * dpr
      const s = Math.sin(rot) * scale * dpr
      ctx.setTransform(c, s, -s, c, gx * dpr, gy * dpr)
      if (glow > 0.01) {
        const R = Math.max(g.w, g.h) * 0.95
        ctx.globalAlpha = glow * alpha
        ctx.drawImage(orb, -R, -R, R * 2, R * 2)
      }
      ctx.globalAlpha = alpha
      if (g.font !== font) ctx.font = font = g.font
      if (g.color !== color) ctx.fillStyle = color = g.color
      ctx.fillText(g.ch, -g.w / 2, -g.h / 2 + g.base)
    }
    if (t >= total) return end()
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
  // 界面在后台时帧回调会暂停：不等了，直接结束
  const onHide = () => document.visibilityState === 'hidden' && end()
  document.addEventListener('visibilitychange', onHide)
  done.then(() => document.removeEventListener('visibilitychange', onHide))

  return { done, skip: end }
}
