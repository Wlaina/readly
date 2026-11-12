import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './styles-060.css'
import { installAppShell } from './lib/appshell'
import { installDiagnostics } from './lib/diag'

// 页面被重新加载（而不是全新启动）时，浏览器会留着上一次的历史状态（“正在阅读某本书”“某个面板开着”）。
// 这些界面此刻都不存在了：清掉，否则返回键会以为阅读器还开着，按了没反应
try {
  if (history.state) history.replaceState(null, '')
} catch {
  /* 忽略 */
}

installDiagnostics()
installAppShell()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// 开发模式下暴露 store，便于调试
if (import.meta.env.DEV) {
  import('./lib/store').then(m => ((window as any).__store = m.useStore))
}
