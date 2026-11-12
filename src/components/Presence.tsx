import { useEffect, useRef, useState, type ReactNode } from 'react'

/** 退场动画时长（与 styles.css 里 .closing 的动画一致） */
const EXIT_MS = 260

/**
 * 退场动画：show 变成 false 时，先保留上一次的内容并加上 .closing，播放退出动画，再真正移除。
 * 包裹层是 display:contents，不影响布局；样式用 `.closing > .sheet` 这类选择器作用到菜单本身。
 * 退场途中又被打开时，直接恢复显示。动画设为“关闭”时立即移除。
 */
export default function Presence({ show, children }: { show: boolean; children: ReactNode }) {
  const last = useRef<ReactNode>(null)
  if (show) last.current = children
  const [closing, setClosing] = useState(false)
  const wasShown = useRef(show)

  useEffect(() => {
    if (show) {
      wasShown.current = true
      setClosing(false)
      return
    }
    if (!wasShown.current) return
    wasShown.current = false
    if (document.documentElement.dataset.motion === 'off') {
      last.current = null
      setClosing(false)
      return
    }
    setClosing(true)
    const t = setTimeout(() => {
      last.current = null
      setClosing(false)
    }, EXIT_MS)
    return () => clearTimeout(t)
  }, [show])

  if (show) return <div className="presence">{children}</div>
  // 刚关闭的这一次渲染（effect 还没跑）也要直接显示退场内容，否则会先消失一帧再出现
  const exiting = closing || (wasShown.current && document.documentElement.dataset.motion !== 'off')
  if (!exiting || !last.current) return null
  return (
    <div className="presence closing" aria-hidden>
      {last.current}
    </div>
  )
}
