import { useState } from 'react'
import { useStore } from '../lib/store'
import { formatTime } from '../lib/hooks'
import { DAV_PRESETS } from '../lib/sync'
import { deviceClass } from '../lib/device'
import { Card, Row, Segmented, Toggle } from './ui'
import { IconCheck, IconSync } from './icons'
import { useTasks } from '../lib/tasks'
import TransferPanel from './TransferPanel'
import { tr } from '../lib/i18n'

const STATUS_TEXT = { idle: '未同步', syncing: '同步中', ok: '已同步', error: '出错了' }

export default function SyncPage() {
  const sync = useStore(s => s.sync)
  const status = useStore(s => s.syncStatus)
  const lastSyncAt = useStore(s => s.lastSyncAt)
  const syncLog = useStore(s => s.syncLog)
  const { updateSync, runSync, testSync } = useStore.getState()
  const [testing, setTesting] = useState(false)
  const [testOk, setTestOk] = useState<boolean | null>(null)
  const [showPwd, setShowPwd] = useState(false)
  const configured = !!(sync.url && sync.username && sync.password)
  const preset = DAV_PRESETS.find(p => sync.url.replace(/\/+$/, '') === p.url.replace(/\/+$/, ''))
  const runningCount = useTasks(s => s.tasks.filter(t => t.status === 'running').length)
  // 记住上次看的是“传输任务”还是“同步设置”；还没配置同步时默认打开设置
  const [view, setView] = useState<'tasks' | 'settings'>(() => {
    try {
      const v = localStorage.getItem('readly.sync.view')
      if (v === 'tasks' || v === 'settings') return v
    } catch {
      /* 忽略 */
    }
    return configured ? 'tasks' : 'settings'
  })
  const pickView = (v: 'tasks' | 'settings') => {
    setView(v)
    try {
      localStorage.setItem('readly.sync.view', v)
    } catch {
      /* 忽略 */
    }
  }

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 760 }}>
        <header className="page-head">
          <div>
            <h1>{tr('云同步')}</h1>
            <div className="sub">{tr('通过 WebDAV 在电脑与手机之间同步书籍、进度与书签')}</div>
          </div>
          <span className={`status-pill ${status}`}>
            <i />
            {sync.enabled ? `${tr(STATUS_TEXT[status])} · ${formatTime(lastSyncAt)}` : tr('未开启')}
          </span>
        </header>

        <div className="tabs sync-tabs">
          <Segmented
            value={view}
            options={[
              ['tasks', `${tr('传输任务')}${runningCount ? ` · ${runningCount}` : ''}`],
              ['settings', tr('同步设置')],
            ]}
            onChange={pickView}
          />
        </div>

        {view === 'tasks' ? (
          <TransferPanel />
        ) : (
        <>
        <Card title={tr('WebDAV 服务器')}>
          <Row label={tr('开启同步')}>
            <Toggle on={sync.enabled} onChange={v => (updateSync({ enabled: v }), v && configured && runSync())} />
          </Row>
          <div style={{ padding: '4px 0 14px' }}>
            <label className="field-label">{tr('服务商')}</label>
            <div className="chips">
              {DAV_PRESETS.map(p => (
                <button key={p.id} className={`chip ${preset?.id === p.id ? 'on' : ''}`} onClick={() => updateSync({ url: p.url })}>
                  <span>{tr(p.name)}</span>
                </button>
              ))}
              <button className={`chip ${!preset ? 'on' : ''}`} onClick={() => updateSync({ url: '' })}>
                <span>{tr('自定义')}</span>
              </button>
            </div>
            <label className="field-label">{tr('服务器地址')}</label>
            <input
              className="field mono"
              value={sync.url}
              placeholder="https://dav.jianguoyun.com/dav/"
              onChange={e => updateSync({ url: e.target.value.trim() })}
              autoCapitalize="off"
              spellCheck={false}
            />
            <div className="grid-2">
              <div>
                <label className="field-label">{tr('账号')}</label>
                <input
                  className="field"
                  value={sync.username}
                  onChange={e => updateSync({ username: e.target.value.trim() })}
                  autoCapitalize="off"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div>
                <label className="field-label">{tr('密码（应用密码）')}</label>
                <div style={{ position: 'relative' }}>
                  <input
                    className="field"
                    type={showPwd ? 'text' : 'password'}
                    value={sync.password}
                    onChange={e => updateSync({ password: e.target.value })}
                    autoComplete="off"
                    style={{ paddingRight: 56 }}
                  />
                  <button
                    className="btn ghost"
                    style={{ position: 'absolute', right: 2, top: 2, height: 38, padding: '0 10px', fontSize: 12.5 }}
                    onClick={() => setShowPwd(!showPwd)}
                  >
                    {showPwd ? tr('隐藏') : tr('显示')}
                  </button>
                </div>
              </div>
            </div>
            <label className="field-label">{tr('云端目录')}</label>
            <input className="field mono" value={sync.root} onChange={e => updateSync({ root: e.target.value.trim() || '/Readly' })} spellCheck={false} />
            <div className="btn-row" style={{ marginTop: 6 }}>
              <button
                className="btn"
                disabled={!configured || testing}
                onClick={async () => {
                  setTesting(true)
                  setTestOk(await testSync())
                  setTesting(false)
                }}
              >
                {testOk && <IconCheck style={{ color: 'var(--sage)' }} />}
                {testing ? tr('连接中…') : testOk === false ? tr('连接失败，重试') : tr('测试连接')}
              </button>
              <button className="btn primary" disabled={!configured || !sync.enabled || status === 'syncing'} onClick={() => runSync()}>
                <IconSync />
                {status === 'syncing' ? tr('同步中…') : tr('立即同步')}
              </button>
            </div>
          </div>
        </Card>

        <Card title={tr('同步内容')}>
          <Row label={tr('阅读进度、书签与阅读时长')} hint={tr('始终同步；进度以最近一次阅读为准，书签自动合并，各设备的阅读时长累加')}>
            <span style={{ color: 'var(--sage)', fontSize: 13 }}>{tr('始终开启')}</span>
          </Row>
          <Row label={tr('书籍文件')} hint={tr('上传本机导入的书，另一台设备会自动下载')}>
            <Toggle on={sync.syncFiles} onChange={v => updateSync({ syncFiles: v })} />
          </Row>
          <Row label={tr('自动导入云端新书')} hint={tr('把 EPUB / TXT 直接放进云端 {dir} 目录，同步时会自动加入书架', { dir: sync.root || '/Readly' })}>
            <Toggle on={sync.scanRoot} onChange={v => updateSync({ scanRoot: v })} />
          </Row>
          <Row
            label={tr('外观与行为设置')}
            hint={tr(deviceClass === 'mobile' ? '电脑与手机分开保存，只在同类设备之间同步（本机是手机）。进度、书签、阅读时长始终在所有设备间同步。' : '电脑与手机分开保存，只在同类设备之间同步（本机是电脑）。进度、书签、阅读时长始终在所有设备间同步。')}
          >
            <Toggle on={sync.syncSettings} onChange={v => updateSync({ syncSettings: v })} />
          </Row>
          <Row label={tr('自动同步')} hint={tr('启动和切回应用时也会同步')}>
            <Segmented
              value={sync.interval}
              options={[
                [0, tr('仅启动时')],
                [5, tr('5 分钟')],
                [10, tr('10 分钟')],
                [30, tr('30 分钟')],
              ]}
              onChange={v => updateSync({ interval: v })}
            />
          </Row>
        </Card>

        {syncLog.length > 0 && (
          <Card title={tr('同步日志')}>
            <div className="log">{syncLog.slice().reverse().join('\n')}</div>
          </Card>
        )}
        </>
        )}
      </div>
    </div>
  )
}
