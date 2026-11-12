/**
 * 让 Readly 用起来像原生应用而不是网页：
 * - 不弹浏览器的右键菜单（输入框除外，保留复制粘贴）
 * - 屏蔽刷新、打印、查找、查看源码、缩放等浏览器快捷键
 * - 图片、链接不能被拖出来
 * - Ctrl+滚轮 / 触控板双指不会缩放整个界面（书架自己的 Ctrl+滚轮切换每排本数不受影响）
 * 阅读器里的书页是独立的 iframe 文档，打开时也调用 guardDocument() 套上同样的规则。
 */

const isEditable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el?.closest?.('input, textarea, [contenteditable="true"], .selectable')
}

/** 浏览器自带、对阅读器没有意义甚至有害的快捷键 */
function isBrowserShortcut(e: KeyboardEvent) {
  const k = e.key.toLowerCase()
  const mod = e.ctrlKey || e.metaKey
  if (k === 'f5' || k === 'f3' || k === 'f7' || k === 'browserback' || k === 'browserforward') return true
  if (e.altKey && (k === 'arrowleft' || k === 'arrowright')) return true // 浏览器前进/后退
  if (!mod) return false
  if (['r', 'p', 'u', 'f', 'g', 's', 'o', 'j', 'h', 'n', 't', 'w', 'l', 'd'].includes(k)) return true
  if (['=', '+', '-', '_', '0'].includes(k)) return true // 缩放
  if (e.shiftKey && ['i', 'j', 'c', 'delete'].includes(k)) return true // 开发者工具
  return false
}

export function guardDocument(doc: Document) {
  doc.addEventListener('contextmenu', e => {
    if (!isEditable(e.target)) e.preventDefault()
  })
  doc.addEventListener(
    'keydown',
    e => {
      // 输入框里的 Ctrl+A / C / V / X / Z 保留；其余浏览器快捷键一律拦下
      if (isEditable(e.target) && (e.ctrlKey || e.metaKey) && ['a', 'c', 'v', 'x', 'z', 'y'].includes(e.key.toLowerCase())) return
      if (isBrowserShortcut(e)) e.preventDefault()
    },
    { capture: true },
  )
  doc.addEventListener('dragstart', e => {
    const t = e.target as HTMLElement | null
    if (t?.closest?.('img, a')) e.preventDefault()
  })
  doc.addEventListener(
    'wheel',
    e => {
      if (e.ctrlKey) e.preventDefault() // 阻止整页缩放；具体组件自己的 Ctrl+滚轮逻辑照常收到事件
    },
    { passive: false },
  )
  // 触控板双指缩放（Safari/WebKit 的 gesture 事件）
  doc.addEventListener('gesturestart', e => e.preventDefault())
}

export function installAppShell() {
  guardDocument(document)
}
