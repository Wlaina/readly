import { useEffect, useMemo, useState } from 'react'
import { useShelf, useStore } from '../lib/store'
import { dayKey } from '../lib/device'
import { formatDuration } from '../lib/hooks'
import { Card, Segmented } from './ui'
import { askConfirm } from '../lib/dialog'
import { IconChevronL, IconChevronR, IconTrash } from './icons'
import { tr } from '../lib/i18n'
import { isEn } from '../lib/i18n'

interface Agg {
  total: number
  byDay: Map<string, number>
  /** 每天每本书的时长：day -> hash -> ms */
  dayBooks: Map<string, Map<string, number>>
  titles: Map<string, string>
  books: { hash: string; title: string; ms: number; removed: boolean }[]
  devices: Map<string, number>
}

function aggregate(library: ReturnType<typeof useStore.getState>['library']): Agg {
  const byDay = new Map<string, number>()
  const devices = new Map<string, number>()
  const books: Agg['books'] = []
  const dayBooks: Agg['dayBooks'] = new Map()
  const titles = new Map<string, string>()
  let total = 0
  for (const b of library) {
    let ms = 0
    for (const s of Object.values(b.readStats ?? {})) {
      ms += s.ms
      devices.set(s.device || '其他', (devices.get(s.device || '其他') ?? 0) + s.ms)
      for (const [d, v] of Object.entries(s.days)) {
        byDay.set(d, (byDay.get(d) ?? 0) + v)
        let m = dayBooks.get(d)
        if (!m) dayBooks.set(d, (m = new Map()))
        m.set(b.hash, (m.get(b.hash) ?? 0) + v)
      }
    }
    titles.set(b.hash, b.title)
    if (ms > 0) books.push({ hash: b.hash, title: b.title, ms, removed: !!b.deletedAt })
    total += ms
  }
  books.sort((a, b) => b.ms - a.ms)
  return { total, byDay, dayBooks, titles, books, devices }
}

type Period = 'week' | 'month' | 'year'

interface Bar {
  /** 这一根柱子覆盖的日期 key（年视图是一个月的所有天） */
  keys: string[]
  label: string
  tip: string
  ms: number
  future: boolean
  isNow: boolean
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日']
const WEEK_EN = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const md = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** 根据视图类型和偏移量（0 = 本周/本月/今年，-1 = 上一个……）算出柱子 */
function buildBars(period: Period, offset: number, byDay: Map<string, number>): { title: string; bars: Bar[] } {
  const now = new Date()
  const todayKey = dayKey(now)
  const dayBar = (d: Date, label: string): Bar => {
    const k = dayKey(d)
    return {
      keys: [k],
      label,
      tip: isEn() ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[(d.getDay() + 6) % 7]}`,
      ms: byDay.get(k) ?? 0,
      future: k > todayKey,
      isNow: k === todayKey,
    }
  }
  if (period === 'week') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) + offset * 7)
    const bars: Bar[] = []
    for (let i = 0; i < 7; i++) bars.push(dayBar(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i), isEn() ? WEEK_EN[i] : WEEK[i]))
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)
    const title =
      offset === 0 ? tr('本周') : offset === -1 ? tr('上周') : isEn() ? `${md(start)} – ${md(end)}` : `${start.getMonth() + 1}月${start.getDate()}日 – ${end.getMonth() + 1}月${end.getDate()}日`
    return { title: start.getFullYear() !== now.getFullYear() ? isEn() ? `${title}, ${start.getFullYear()}` : `${start.getFullYear()}年 ${title}` : title, bars }
  }
  if (period === 'month') {
    const first = new Date(now.getFullYear(), now.getMonth() + offset, 1)
    const n = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
    const bars: Bar[] = []
    for (let i = 1; i <= n; i++) bars.push(dayBar(new Date(first.getFullYear(), first.getMonth(), i), i === 1 || i % 5 === 0 ? String(i) : ''))
    const title =
      offset === 0
        ? tr('本月')
        : isEn()
          ? first.toLocaleDateString('en-US', first.getFullYear() !== now.getFullYear() ? { month: 'long', year: 'numeric' } : { month: 'long' })
          : `${first.getFullYear() !== now.getFullYear() ? `${first.getFullYear()}年` : ''}${first.getMonth() + 1}月`
    return { title, bars }
  }
  const y = now.getFullYear() + offset
  const bars: Bar[] = []
  for (let m = 0; m < 12; m++) {
    const n = new Date(y, m + 1, 0).getDate()
    const keys: string[] = []
    let ms = 0
    for (let i = 1; i <= n; i++) {
      const k = dayKey(new Date(y, m, i))
      keys.push(k)
      ms += byDay.get(k) ?? 0
    }
    bars.push({
      keys,
      label: String(m + 1),
      tip: isEn() ? new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : `${y}年${m + 1}月`,
      ms,
      future: y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth()),
      isNow: y === now.getFullYear() && m === now.getMonth(),
    })
  }
  return { title: offset === 0 ? tr('今年') : isEn() ? String(y) : `${y}年`, bars }
}

export default function StatsPage() {
  // 阅读时冻结（见 useShelf）：翻页保存进度不会让统计页跟着重算
  const library = useShelf(s => s.library)
  const agg = useMemo(() => aggregate(library), [library])
  const [hover, setHover] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [period, setPeriod] = useState<Period>('week')
  const [offset, setOffset] = useState(0)
  const [picked, setPicked] = useState<number | null>(null)
  const removedBooks = agg.books.filter(b => b.removed)

  // 最早有记录的日期：决定能往回翻多远
  const firstDay = useMemo(() => [...agg.byDay].filter(([, v]) => v > 0).map(([k]) => k).sort()[0], [agg])
  const { title, bars } = useMemo(() => buildBars(period, offset, agg.byDay), [period, offset, agg])
  const canPrev = !!firstDay && bars[0].keys[0] > firstDay
  const canNext = offset < 0

  // 换视图/翻页时：当前时段默认选中今天/本月，过去的时段选中最后一根有数据的柱子
  useEffect(() => {
    const now = bars.findIndex(b => b.isNow)
    if (now >= 0) return setPicked(now)
    let last = -1
    bars.forEach((b, i) => {
      if (b.ms > 0) last = i
    })
    setPicked(last >= 0 ? last : null)
  }, [bars])

  const switchPeriod = (p: Period) => {
    setPeriod(p)
    setOffset(0)
    setHover(null)
  }

  const todayMs = agg.byDay.get(dayKey()) ?? 0
  let week = 0
  for (let i = 0; i < 7; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    week += agg.byDay.get(dayKey(d)) ?? 0
  }
  // 连续阅读天数（今天没读则从昨天往前数）
  let streak = 0
  for (let i = 0; ; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const v = agg.byDay.get(dayKey(d)) ?? 0
    if (v >= 60_000) streak++
    else if (i > 0) break
    if (i > 3650) break
  }
  const max = Math.max(...bars.map(d => d.ms), 60_000)
  const bookMax = agg.books[0]?.ms ?? 1
  const periodTotal = bars.reduce((a, b) => a + b.ms, 0)
  const activeUnits = bars.filter(b => b.ms >= 60_000).length

  // 选中的那一天/那个月读了哪些书
  const sel = picked != null ? bars[picked] ?? null : null
  const selBooks = useMemo(() => {
    if (!sel) return []
    const m = new Map<string, number>()
    for (const k of sel.keys) for (const [h, v] of agg.dayBooks.get(k) ?? []) m.set(h, (m.get(h) ?? 0) + v)
    return [...m]
      .map(([hash, ms]) => ({ hash, ms, title: agg.titles.get(hash) ?? tr('未知书籍') }))
      .filter(b => b.ms >= 1000)
      .sort((a, b) => b.ms - a.ms)
  }, [sel, agg])
  const selMax = selBooks[0]?.ms ?? 1

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 760 }}>
        <header className="page-head">
          <div>
            <h1>{tr('阅读统计')}</h1>
            <div className="sub">{tr('所有设备的阅读时长会通过云同步合并')}</div>
          </div>
        </header>

        <div className="stat-tiles">
          {[
            [tr('今天'), formatDuration(todayMs)],
            [tr('近 7 天'), formatDuration(week)],
            [tr('累计'), formatDuration(agg.total)],
            [tr('连续阅读'), tr('{n} 天', { n: streak })],
          ].map(([label, value], i) => (
            <div key={label} className="stat-tile glass rise" style={{ animationDelay: `${i * 50}ms` }}>
              <span>{label}</span>
              <b className="serif">{value}</b>
            </div>
          ))}
        </div>

        <Card
          title={
            <span className="card-title-row">
              {tr('阅读记录')}
              <Segmented
                value={period}
                options={[
                  ['week', tr('周')],
                  ['month', tr('月')],
                  ['year', tr('年')],
                ]}
                onChange={switchPeriod}
              />
            </span>
          }
        >
          <div className="hist-nav">
            <button className="icon-btn" aria-label={tr('上一段')} disabled={!canPrev} onClick={() => setOffset(o => o - 1)}>
              <IconChevronL />
            </button>
            <div className="hist-title">
              <b className="serif">{title}</b>
              <span>
                {tr(period === 'year' ? '共 {total} · 读了 {n} 个月' : '共 {total} · 读了 {n} 天', { total: formatDuration(periodTotal), n: activeUnits })}
              </span>
            </div>
            <button className="icon-btn" aria-label={tr('下一段')} disabled={!canNext} onClick={() => setOffset(o => o + 1)}>
              <IconChevronR />
            </button>
          </div>
          <div
            className={`chart chart-${period}`}
            key={`${period}${offset}`}
            style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}
            role="img"
            aria-label={tr('{title}的阅读时长', { title })}
          >
            {bars.map((d, i) => (
              <div
                key={d.keys[0]}
                className={`chart-col ${picked === i ? 'picked' : ''} ${d.future ? 'future' : ''}`}
                onPointerEnter={e => e.pointerType === 'mouse' && setHover(i)}
                onPointerLeave={() => setHover(null)}
                onClick={() => !d.future && setPicked(i)}
              >
                {hover === i && !d.future && (
                  <div className="chart-tip glass">
                    {d.tip}
                    <b>{formatDuration(d.ms)}</b>
                  </div>
                )}
                <div className="chart-bar-wrap">
                  <i className="chart-bar" style={{ height: `${(d.ms / max) * 100}%`, animationDelay: `${Math.min(i, 20) * 18}ms` }} />
                </div>
                <span className={`chart-x ${d.isNow ? 'today' : ''}`}>{d.label}</span>
              </div>
            ))}
          </div>

          {sel && (
            <div className="hist-detail" key={sel.keys[0] + period}>
              <div className="hist-detail-head">
                <span>{sel.tip}</span>
                <b>{formatDuration(sel.ms)}</b>
              </div>
              {selBooks.length === 0 ? (
                <p className="hist-empty">{tr(period === 'year' ? '这个月没有阅读记录' : '这天没有阅读记录')}</p>
              ) : (
                selBooks.map(b => (
                  <div key={b.hash} className="rank-row">
                    <div className="rank-top">
                      <span className="rank-title">{b.title}</span>
                      <span className="rank-val">{formatDuration(b.ms)}</span>
                    </div>
                    <div className="progress-line">
                      <i style={{ width: `${(b.ms / selMax) * 100}%` }} />
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </Card>

        <Card
          title={
            <span className="card-title-row">
              {tr('读得最多的书')}
              {agg.books.length > 0 && (
                <button className="btn ghost card-title-btn" onClick={() => setEditing(!editing)}>
                  {editing ? tr('完成') : tr('编辑')}
                </button>
              )}
            </span>
          }
        >
          {editing && (
            <div className="stats-edit-bar">
              <span>{tr('清除后，这本书在所有设备上的阅读时长都会归零（同步后生效）。')}</span>
              {removedBooks.length > 0 && (
                <button
                  className="btn danger"
                  onClick={async () => {
                    const ok = await askConfirm({
                      title: tr('清除 {n} 本已移除书籍的统计？', { n: removedBooks.length }),
                      message: tr('这些书已经不在书架上了，清除后统计里不再显示。'),
                      okText: tr('清除'),
                      danger: true,
                    })
                    if (ok) useStore.getState().clearStats(removedBooks.map(b => b.hash))
                  }}
                >
                  <IconTrash />
                  {tr('清除已移除书籍（{n}）', { n: removedBooks.length })}
                </button>
              )}
            </div>
          )}
          {agg.books.length === 0 ? (
            <p style={{ color: 'var(--muted)', margin: '14px 0' }}>{tr('开始读一本书，这里就会记录下时间。')}</p>
          ) : (
            (editing ? agg.books : agg.books.slice(0, 12)).map(b => (
              <div key={b.hash} className="rank-row">
                <div className="rank-top">
                  <span className="rank-title">
                    {b.title}
                    {b.removed && <em>{tr('（已移除）')}</em>}
                  </span>
                  <span className="rank-val">{formatDuration(b.ms)}</span>
                  {editing && (
                    <button
                      className="icon-btn rank-del"
                      aria-label={tr('清除《{title}》的统计', { title: b.title })}
                      onClick={async () => {
                        const ok = await askConfirm({ title: tr('清除《{title}》的阅读统计？', { title: b.title }), okText: tr('清除'), danger: true })
                        if (ok) useStore.getState().clearStats([b.hash])
                      }}
                    >
                      <IconTrash />
                    </button>
                  )}
                </div>
                <div className="progress-line">
                  <i style={{ width: `${(b.ms / bookMax) * 100}%` }} />
                </div>
              </div>
            ))
          )}
        </Card>

        {agg.devices.size > 1 && (
          <Card title={tr('按设备')}>
            {[...agg.devices].map(([name, ms]) => (
              <div key={name} className="row">
                <div className="row-label">{tr(name)}</div>
                <div className="row-control mono" style={{ fontSize: 13 }}>
                  {formatDuration(ms)}
                </div>
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  )
}
