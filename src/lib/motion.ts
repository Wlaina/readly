/**
 * 动画风格：soft 柔和渐变（默认）/ slide 轻推滑入 / focus 景深聚焦 / magic 魔法微光 / lively 灵动弹性 / off 关闭。
 * soft 模式下，切换深浅色时用 View Transitions 做整屏交叉渐变：
 * 浏览器给新旧两个画面各拍一张快照，在 GPU 上淡出淡入，比手写动画更顺滑也更省。
 *
 * 动画速度：所有 CSS 动画、过渡开始时统一调整播放速度（见 setMotionSpeed），
 * 我们自己用 element.animate 写的动画（开合书、文字特效、面板）用 motionScale() 换算时长。
 */
import { flushSync } from 'react-dom'

export type Motion = 'soft' | 'slide' | 'focus' | 'magic' | 'lively' | 'off'
export type MotionSpeed = 'slow' | 'normal' | 'fast'

let current: Motion = 'soft'
let rate = 1

const RATES: Record<MotionSpeed, number> = { slow: 0.72, normal: 1, fast: 1.45 }

/** 自己写的动画的时长要乘以这个数（慢速时变长、快速时变短） */
export const motionScale = () => 1 / rate

/**
 * 切换动画风格。换风格会改变很多元素的 animation 属性，浏览器会把已经播完的入场动画重新播一遍，
 * 整个界面就会“弹”一下。所以切换后立刻把这些一次性动画直接跳到结尾，只有之后新出现的元素才用新风格。
 */
export function applyMotion(m: Motion) {
  current = m
  const root = document.documentElement
  if (root.dataset.motion === m) return
  const first = !root.dataset.motion
  root.dataset.motion = m
  if (first || typeof document.getAnimations !== 'function') return
  for (const a of document.getAnimations()) {
    const timing = a.effect?.getTiming()
    if (!timing || timing.iterations === Infinity) continue // 莫奈背景等循环动画保持原样
    // 绑定在滚动位置上的动画（单本模式的封面流）不是“播一次就完”的入场动画：
    // 把它 finish() 会让封面永远停在终点（完全透明），整排封面就不见了
    if (a.timeline && a.timeline !== document.timeline) continue
    // 设置页里的预览小窗：换了风格就是要让它把新动画播一遍
    const target = (a.effect as KeyframeEffect | null)?.target as Element | null
    if (target?.closest?.('.motion-demo')) continue
    try {
      a.finish()
    } catch {
      /* 个别动画无法结束，忽略 */
    }
  }
}

/** 给刚开始的 CSS 动画 / 过渡套上全局速度 */
function adjust(e: Event) {
  if (rate === 1) return
  const t = e.target as Element | null
  if (!t?.getAnimations) return
  for (const a of t.getAnimations()) {
    if (a.playbackRate !== 1) continue // 已经调过（或是我们自己设过速度的动画）
    if (a.timeline && a.timeline !== document.timeline) continue // 滚动驱动的动画跟着手指走，不能改
    if (a.effect?.getTiming().iterations === Infinity) continue // 莫奈背景这类循环动画保持原速
    a.playbackRate = rate
  }
}
let listening = false

/** 动画速度：慢 / 标准 / 快 */
export function setMotionSpeed(s: MotionSpeed) {
  rate = RATES[s] ?? 1
  document.documentElement.dataset.speed = s
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener('animationstart', adjust, true)
  document.addEventListener('transitionrun', adjust, true)
}

type VTDocument = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } }

let running = false

/**
 * 整屏交叉渐变：要给整个页面拍快照，手机上很贵，所以只用在“切换深浅色”这种一次性的大变化上；
 * 切页、开书等高频操作改用页面自身的 CSS 淡入（见 styles.css 的 soft-in），几乎零开销。
 * 上一次渐变还没结束时不再叠加，直接更新。
 */
export function withTransition(update: () => void) {
  crossfade(update, current === 'soft' || current === 'magic')
}

/** 整屏渐变（除“关闭动画”外的所有风格都生效）：用于阅读页日间/夜间背景切换这类整页变色 */
export function fadeTransition(update: () => void) {
  crossfade(update, current !== 'off')
}

function crossfade(update: () => void, enabled: boolean) {
  const doc = document as VTDocument
  if (running || !enabled || !doc.startViewTransition || document.visibilityState !== 'visible') {
    update()
    return
  }
  try {
    running = true
    doc
      .startViewTransition(async () => {
        flushSync(update)
        // 让随之而来的副作用（例如把新配色套进书页）先跑完，新画面的快照里才是完整的新样子
        await new Promise(r => setTimeout(r, 0))
      })
      .finished.finally(() => (running = false))
  } catch {
    running = false
    update()
  }
}
