/**
 * 打开 / 合上书的动画：书架上的那张封面“翻开”并放大成整页，合上时原路收回到封面的位置。
 *
 * 做法：在封面原位放一个临时图层（一张纸 + 一份封面的复制品），只动 transform，全程由 GPU 合成：
 * - 打开：整体从封面的位置放大到铺满屏幕，同时封面绕左侧书脊翻开；最后真正的阅读页在它上面淡入。
 * - 合上：阅读页淡出，露出同色的纸，纸缩回封面的位置，同时封面合上。
 * 找不到封面（书不在屏幕上、从“打开方式”进来等）或关闭了动画时，退回简单的淡入淡出。
 */
import { useStore } from './store'
import { activeReaderTheme } from './settings'

export const OPEN_MS = 540
export const CLOSE_MS = 460
/** 没有翻书动画时，阅读页淡入淡出的时长 */
export const FADE_MS = 220

let box: HTMLElement | null = null
let hidden: HTMLElement | null = null
let timer: ReturnType<typeof setTimeout> | undefined

function cleanup() {
  clearTimeout(timer)
  box?.remove()
  box = null
  hidden?.style.removeProperty('visibility')
  hidden = null
  document.documentElement.style.removeProperty('--reader-in-delay')
}

function enabled() {
  if (document.documentElement.dataset.motion === 'off') return false
  if (useStore.getState().settings.bookAnim !== 'open') return false
  if (typeof Element.prototype.animate !== 'function') return false
  return !matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 找到这本书在屏幕上的封面（书架网格或单本轮播里正中的那本） */
function findCover(hash: string) {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-book="${hash}"] .cover`)) {
    if (el.closest('.tab-pane.inactive, .book-sheet')) continue
    const r = el.getBoundingClientRect()
    if (r.width < 24 || r.height < 24) continue
    // 大部分要在屏幕里，否则动画的起点/终点看不见，反而奇怪
    const visW = Math.min(r.right, innerWidth) - Math.max(r.left, 0)
    const visH = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)
    if (visW < r.width * 0.6 || visH < r.height * 0.5) continue
    return { el, r }
  }
  return null
}

function build(hash: string) {
  const found = findCover(hash)
  if (!found) return null
  cleanup()
  const { el, r } = found
  const theme = activeReaderTheme(useStore.getState().settings.reading)
  box = document.createElement('div')
  box.className = 'book-fx'
  box.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`
  const page = document.createElement('div')
  page.className = 'book-fx-page'
  page.style.background = theme.bg
  const cover = el.cloneNode(true) as HTMLElement
  cover.removeAttribute('style')
  cover.className = 'cover book-fx-cover'
  cover.querySelectorAll('.check, .badge').forEach(n => n.remove())
  box.append(page, cover)
  document.body.append(box)
  el.style.visibility = 'hidden'
  hidden = el
  // 等比放大到盖住整个屏幕（纸是纯色，多出去的部分被屏幕裁掉）
  const scale = Math.max(innerWidth / r.width, innerHeight / r.height) * 1.05
  const dx = innerWidth / 2 - (r.left + r.width / 2)
  const dy = innerHeight / 2 - (r.top + r.height / 2)
  return { box, cover, full: `translate3d(${dx}px, ${dy}px, 0) scale(${scale})` }
}

/** 打开书的动画。返回动画时长（毫秒）；返回 0 表示没有翻书动画，调用方按简单淡入处理 */
export function openFx(hash: string): number {
  if (!enabled()) return 0
  const fx = build(hash)
  if (!fx) return 0
  fx.box.animate([{ transform: 'translate3d(0, 0, 0) scale(1)' }, { transform: fx.full }], {
    duration: OPEN_MS,
    easing: 'cubic-bezier(.32, .08, .24, 1)',
    fill: 'forwards',
  })
  fx.cover.animate(
    [
      { transform: 'rotateY(0deg)', opacity: 1 },
      { transform: 'rotateY(-88deg)', opacity: 1, offset: 0.62 },
      { transform: 'rotateY(-130deg)', opacity: 0 },
    ],
    { duration: OPEN_MS * 0.86, easing: 'cubic-bezier(.4, 0, .3, 1)', fill: 'forwards' },
  )
  // 真正的阅读页在动画的最后一段淡入，盖在这层上面
  document.documentElement.style.setProperty('--reader-in-delay', `${OPEN_MS - FADE_MS}ms`)
  timer = setTimeout(cleanup, OPEN_MS + 120)
  return OPEN_MS
}

/** 合上书的动画（此时书架已经显示出来）。返回时长；0 表示没有翻书动画 */
export function closeFx(hash: string): number {
  if (!enabled()) return 0
  const fx = build(hash)
  if (!fx) return 0
  fx.box.animate([{ transform: fx.full }, { transform: 'translate3d(0, 0, 0) scale(1)' }], {
    duration: CLOSE_MS,
    easing: 'cubic-bezier(.5, 0, .2, 1)',
    fill: 'both',
  })
  fx.cover.animate(
    [
      { transform: 'rotateY(-130deg)', opacity: 0 },
      { transform: 'rotateY(-88deg)', opacity: 1, offset: 0.3 },
      { transform: 'rotateY(0deg)', opacity: 1 },
    ],
    { duration: CLOSE_MS, easing: 'cubic-bezier(.3, 0, .2, 1)', fill: 'both' },
  )
  timer = setTimeout(cleanup, CLOSE_MS + 20)
  return CLOSE_MS
}

/** 最近一次打开书时用了多长的动画（App 据此决定什么时候把书架藏起来） */
let lastOpenMs = 0
export const setOpenMs = (ms: number) => (lastOpenMs = ms)
export const getOpenMs = () => lastOpenMs
