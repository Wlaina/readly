import { useEffect, useState } from 'react'
import { useStore } from '../lib/store'
import { tr } from '../lib/i18n'
import { checkForUpdate, installUpdate, RELEASES_PAGE, updateSupported, useUpdate } from '../lib/updater'
import { buildReport, exportReport } from '../lib/diag'
import { deviceClass, isAndroid } from '../lib/device'
import { isTauri } from '../lib/storage'
import { Card, Row, Toggle } from './ui'
import { openUrl } from '../lib/native'

const SHORTCUTS: [string, string][] = [
  ['Esc', '返回 / 关闭菜单'],
  ['← →', '翻页'],
  ['Enter / M', '显示或隐藏阅读工具栏'],
  ['T', '目录'],
  ['B / Ctrl+D', '添加或删除书签'],
  ['F / Ctrl+F', '书内搜索'],
  ['N', '高亮与笔记'],
  ['A', '阅读外观'],
  ['O', '翻页与操作'],
  ['D', '切换日间 / 夜间背景'],
  ['F11', '全屏'],
  ['Ctrl+1 ~ 4', '切换书架 / 统计 / 同步 / 设置'],
  ['Ctrl+F', '书架：搜索书名'],
  ['Ctrl+O', '书架：导入书籍'],
]

export default function AboutCard() {
  const settings = useStore(s => s.settings)
  const up = useUpdate()
  const [version, setVersion] = useState('0.8.2')
  const [exporting, setExporting] = useState(false)
  useEffect(() => {
    if (!isTauri) return
    import('@tauri-apps/api/app').then(m => m.getVersion()).then(setVersion, () => {})
  }, [])

  const updateText =
    up.status === 'checking'
      ? tr('正在检查…')
      : up.status === 'none'
        ? tr('已是最新版本')
        : up.status === 'available'
          ? tr('发现新版本 {v}', { v: up.version })
          : up.status === 'downloading'
            ? tr('正在下载 {pct}%', { pct: Math.round(up.progress * 100) })
            : up.status === 'installing'
              ? tr('正在安装…')
              : up.status === 'error'
                ? tr('检查失败：{e}', { e: up.error })
                : ''

  const exportDiag = async () => {
    setExporting(true)
    try {
      const st = useStore.getState()
      const books = st.library.filter(b => !b.deletedAt)
      let host = ''
      try {
        host = st.sync.url ? new URL(st.sync.url).host : ''
      } catch {
        host = '(invalid url)'
      }
      const text = buildReport({
        版本: version,
        平台: `${deviceClass}${isAndroid ? ' / Android' : ''}`,
        语言: settings.lang,
        界面: { appTheme: settings.appTheme, motion: settings.motion, glass: settings.glass, monet: settings.monet, shelfColumns: settings.shelfColumns },
        阅读: { theme: settings.reading.theme, font: settings.reading.font, fontSize: settings.reading.fontSize, flow: settings.behavior.flow, animated: settings.behavior.animated },
        书架: `${books.length} 本，本机有文件 ${books.filter(b => b.hasFile).length} 本，高亮/笔记 ${books.reduce((a, b) => a + (b.annotations?.filter(x => !x.deleted).length ?? 0), 0)} 条`,
        同步: { enabled: st.sync.enabled, server: host, lastSyncAt: st.lastSyncAt ? new Date(st.lastSyncAt).toISOString() : null, status: st.syncStatus },
        书籍文件夹: st.folders.map(f => ({ count: f.count, error: f.error, failed: f.failed?.length })),
      })
      const r = await exportReport(text)
      if (r === 'saved') st.showToast(tr('诊断日志已保存'))
      else if (r === 'copied') st.showToast(tr('诊断日志已复制到剪贴板'))
    } catch (e) {
      useStore.getState().showToast(tr('导出失败：{e}', { e: e instanceof Error ? e.message : String(e) }))
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <Card>
        <Row label={tr('版本')} hint={updateText || undefined}>
          <div className="btn-row" style={{ alignItems: 'center' }}>
            <span className="mono" style={{ fontSize: 13 }}>
              Readly {version}
            </span>
            {updateSupported &&
              (up.status === 'available' ? (
                <button className="btn primary" onClick={installUpdate}>
                  {tr('立即更新')}
                </button>
              ) : (
                <button className="btn" disabled={['checking', 'downloading', 'installing'].includes(up.status)} onClick={() => checkForUpdate()}>
                  {tr('检查更新')}
                </button>
              ))}
          </div>
        </Row>
        {(up.status === 'downloading' || up.status === 'installing') && (
          <div className="progress-line" style={{ margin: '0 0 12px' }}>
            <i style={{ width: `${up.progress * 100}%` }} />
          </div>
        )}
        {updateSupported && (
          <Row
            label={tr('自动检查更新')}
            hint={isAndroid ? tr('有新版本时在书架上提示；更新会下载新的安装包并调起系统安装') : tr('有新版本时在书架上提示；更新会自动安装并重启 Readly')}
          >
            <Toggle on={settings.autoUpdate ?? true} onChange={v => useStore.getState().updateSettings(s => ({ ...s, autoUpdate: v }))} />
          </Row>
        )}
        <Row label={tr('发布页面')} hint={RELEASES_PAGE}>
          <button className="btn" onClick={() => openUrl(RELEASES_PAGE).catch(e => useStore.getState().showToast(String(e)))}>
            {tr('打开')}
          </button>
        </Row>
        <Row label={tr('诊断日志')} hint={tr('遇到问题时导出发给开发者；不包含密码、账号等敏感信息')}>
          <button className="btn" disabled={exporting} onClick={exportDiag}>
            {isAndroid ? tr('导出并分享') : tr('导出')}
          </button>
        </Row>
        <Row label={tr('渲染引擎')}>
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>foliate-js（MIT）</span>
        </Row>
      </Card>
      {deviceClass === 'desktop' ? (
        <Card title={tr('键盘快捷键')}>
          <div className="shortcut-list">
            {SHORTCUTS.map(([k, d]) => (
              <div key={k} className="shortcut">
                <kbd>{k}</kbd>
                <span>{tr(d)}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card>
          <Row label={tr('快捷操作')} hint={tr('书架：双指缩放切换每排本数；底部导航：长按后左右滑动切换页面；阅读：选中文字可高亮或写笔记')}>
            <span />
          </Row>
        </Card>
      )}
    </>
  )
}
