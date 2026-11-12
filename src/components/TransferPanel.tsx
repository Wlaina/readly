import { useEffect, useState } from 'react'
import { clearFinished, KIND_LABEL, useTasks, type Task } from '../lib/tasks'
import { useStore } from '../lib/store'
import { Card } from './ui'
import { IconCheck, IconDownload, IconSync, IconTransfer, IconX } from './icons'
import { tr } from '../lib/i18n'

const fmtBytes = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`

const fmtDur = (ms: number) => (ms < 1000 ? tr('{n} 毫秒', { n: ms }) : ms < 60_000 ? tr('{n} 秒', { n: (ms / 1000).toFixed(1) }) : tr('{n} 分钟', { n: Math.round(ms / 60_000) }))

function TaskIcon({ t }: { t: Task }) {
  if (t.status === 'done') return <IconCheck />
  if (t.status === 'error') return <IconX />
  if (t.kind === 'download') return <IconDownload />
  if (t.kind === 'upload') return <IconDownload style={{ transform: 'rotate(180deg)' }} />
  if (t.kind === 'sync' || t.kind === 'pull' || t.kind === 'push') return <IconSync />
  return <IconTransfer />
}

function TaskRow({ t, now }: { t: Task; now: number }) {
  const ratio = t.total ? Math.min(1, (t.loaded ?? 0) / t.total) : null
  const amount =
    t.unit === 'bytes'
      ? t.total
        ? `${fmtBytes(t.loaded ?? 0)} / ${fmtBytes(t.total)}`
        : t.loaded
          ? fmtBytes(t.loaded)
          : ''
      : t.unit === 'items' && t.total
        ? `${t.loaded ?? 0} / ${t.total}`
        : ''
  const time = t.status === 'running' ? fmtDur(now - t.startedAt) : t.endedAt ? new Date(t.endedAt).toLocaleTimeString() : ''
  return (
    <div className={`task-row ${t.status}`}>
      <span className="task-icon">
        <TaskIcon t={t} />
      </span>
      <div className="task-main">
        <div className="task-top">
          <span className="task-kind">{tr(KIND_LABEL[t.kind])}</span>
          <span className="task-title">{t.title}</span>
          <span className="task-time">{time}</span>
        </div>
        {t.status === 'running' && (
          <div className={`task-bar ${ratio === null ? 'indeterminate' : ''}`}>
            <i style={ratio !== null ? { width: `${ratio * 100}%` } : undefined} />
          </div>
        )}
        <div className="task-sub">
          {t.status === 'error' ? <span className="task-err">{tr('失败：{e}', { e: t.error ?? '' })}</span> : t.detail || amount}
          {t.status === 'running' && ratio !== null && <span>{Math.round(ratio * 100)}%</span>}
          {t.status !== 'running' && amount && !t.detail && null}
        </div>
      </div>
    </div>
  )
}

/** 同步 → 传输任务：正在进行与最近完成的同步、上传、下载、导入 */
export default function TransferPanel() {
  const tasks = useTasks(s => s.tasks)
  const syncEnabled = useStore(s => s.sync.enabled)
  const syncStatus = useStore(s => s.syncStatus)
  const running = tasks.filter(t => t.status === 'running')
  const finished = tasks.filter(t => t.status !== 'running')
  // 有任务在跑时每秒刷新一次耗时
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running.length) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running.length])

  return (
    <>
      <Card
        title={
          <span className="card-title-row">
            {tr('正在进行')}{running.length ? ` · ${running.length}` : ''}
            {syncEnabled && (
              <button className="btn ghost card-title-btn" disabled={syncStatus === 'syncing'} onClick={() => useStore.getState().runSync()}>
                <IconSync />
                {tr('立即同步')}
              </button>
            )}
          </span>
        }
      >
        {running.length ? (
          running.map(t => <TaskRow key={t.id} t={t} now={now} />)
        ) : (
          <p className="task-empty">{tr('没有正在进行的任务')}{syncEnabled ? '' : tr('（云同步未开启）')}</p>
        )}
      </Card>

      <Card
        title={
          <span className="card-title-row">
            {tr('最近完成')}
            {finished.length > 0 && (
              <button className="btn ghost card-title-btn" onClick={clearFinished}>
                {tr('清除记录')}
              </button>
            )}
          </span>
        }
      >
        {finished.length ? finished.map(t => <TaskRow key={t.id} t={t} now={now} />) : <p className="task-empty">{tr('还没有记录')}</p>}
      </Card>
    </>
  )
}
