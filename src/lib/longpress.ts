/**
 * 统一的长按判定（书架、单本轮播共用）。以前每本书各自起一个计时器，
 * 两根手指轻点会起两个计时器、只取消掉一个，半秒后菜单就“自己”弹出来了。
 * 现在全局只有一个计时器，且必须满足：
 * - 只有一根手指（第二根手指一落下立即作废，双指缩放、轻点都不会触发）
 * - 按住期间移动不超过 10px（滑动、滚动不会触发）
 * - 按满 520ms 且手指还没抬起
 */
import type { TouchEvent as RTouchEvent } from 'react'

const HOLD_MS = 520
const SLOP = 10
let timer: ReturnType<typeof setTimeout> | undefined
let sx = 0
let sy = 0
let fired = false

export function cancelLongPress() {
  clearTimeout(timer)
  timer = undefined
}

if (typeof window !== 'undefined') {
  // 任何地方出现第二根手指、或页面开始滚动，都取消正在进行的长按
  window.addEventListener('touchstart', e => e.touches.length > 1 && cancelLongPress(), { capture: true, passive: true })
  window.addEventListener('scroll', cancelLongPress, { capture: true, passive: true })
}

/** 给一个元素用的触摸处理：fire 是长按成立时要做的事 */
export function longPress(fire: () => void) {
  return {
    onTouchStart(e: RTouchEvent) {
      cancelLongPress()
      fired = false
      if (e.touches.length !== 1) return
      sx = e.touches[0].clientX
      sy = e.touches[0].clientY
      timer = setTimeout(() => {
        timer = undefined
        fired = true
        fire()
      }, HOLD_MS)
    },
    onTouchMove(e: RTouchEvent) {
      if (!timer) return
      const t = e.touches[0]
      if (e.touches.length !== 1 || !t || Math.hypot(t.clientX - sx, t.clientY - sy) > SLOP) cancelLongPress()
    },
    onTouchEnd: cancelLongPress,
    onTouchCancel: cancelLongPress,
  }
}

/** 这次点击是否紧跟在一次已成立的长按之后（用来吞掉松手时触发的 click） */
export function consumeLongPress() {
  const f = fired
  fired = false
  return f
}
