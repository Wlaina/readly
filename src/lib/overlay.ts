/**
 * 浮层与返回键：打开一个面板时压入一条历史记录，安卓返回键（或浏览器后退）先关掉最上面的面板。
 * 用法：const dismiss = pushOverlay(() => setOpen(false))；要用代码关闭时调用 dismiss()。
 * 必须在事件处理函数里调用（不要放在 effect 里：开发模式下 effect 会跑两次）。
 */
interface Entry {
  token: string
  close: () => void
}
const stack: Entry[] = []
let seq = 0

export function pushOverlay(close: () => void): () => void {
  const token = `ov${Date.now().toString(36)}${seq++}`
  history.pushState({ overlay: token }, '')
  stack.push({ token, close })
  return () => {
    const i = stack.findIndex(x => x.token === token)
    if (i < 0) return
    // 它的历史记录还在最上面：回退一步，由下面的 popstate 统一关闭
    if (history.state?.overlay === token) history.back()
    else {
      stack.splice(i, 1)
      close()
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    // 回退之后，凡是历史记录已经不在最上面的浮层都关掉
    while (stack.length && history.state?.overlay !== stack[stack.length - 1].token) stack.pop()!.close()
  })
}
