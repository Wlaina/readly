/**
 * 第一次启动时的引导：语言 → 界面外观 → 阅读偏好 → 云同步（可跳过）。
 * 每一步改的都是真正的设置，立刻生效（背后的界面会跟着变），之后都能在“设置”里再改。
 * 从旧版本升级上来的不会看到它；“关于”里可以重新打开。
 */
import { useState } from 'react'
import { useStore } from '../lib/store'
import { ACCENTS, LIGHT_THEMES, DARK_THEMES, READER_THEMES, type ReaderThemeId } from '../lib/settings'
import { setAppTheme } from '../lib/hooks'
import { DAV_PRESETS } from '../lib/sync'
import { isTauri } from '../lib/storage'
import { tr } from '../lib/i18n'
import { Segmented, Stepper, Toggle } from './ui'
import { IconCheck } from './icons'

/** 切换语言会让整个界面重新挂载：当前走到第几步记在组件外面 */
let savedStep = 0
const STEPS = 4
const THEME_CHOICES: ReaderThemeId[] = [...LIGHT_THEMES.slice(0, 5), ...DARK_THEMES.slice(0, 2)]

export default function Onboarding() {
  const settings = useStore(s => s.settings)
  const sync = useStore(s => s.sync)
  const { updateSettings, updateSync } = useStore.getState()
  const [step, setStepState] = useState(savedStep)
  const [dir, setDir] = useState(1)
  const go = (n: number) => {
    setDir(n > step ? 1 : -1)
    setStepState((savedStep = Math.max(0, Math.min(STEPS - 1, n))))
  }
  const [testing, setTesting] = useState(false)
  const [linked, setLinked] = useState<boolean | null>(null)
  const preset = DAV_PRESETS.find(p => sync.url.replace(/\/+$/, '') === p.url.replace(/\/+$/, ''))
  const filled = !!(sync.url && sync.username && sync.password)

  const finish = () => {
    savedStep = 0
    updateSettings(s => ({ ...s, onboarded: true }))
  }
  const connect = async () => {
    setTesting(true)
    const ok = await useStore.getState().testSync()
    setTesting(false)
    setLinked(ok)
    if (ok) {
      updateSync({ enabled: true })
      useStore.getState().runSync()
    }
  }
  const r = settings.reading
  const b = settings.behavior

  return (
    <div className="onboarding" role="dialog" aria-modal="true" aria-label={tr('欢迎使用 Readly')}>
      <div className="onb-card glass">
        <div className="onb-dots" aria-hidden>
          {Array.from({ length: STEPS }, (_, i) => (
            <i key={i} className={i === step ? 'on' : i < step ? 'done' : ''} />
          ))}
        </div>

        <div className={`onb-step ${dir > 0 ? 'from-right' : 'from-left'}`} key={step}>
          {step === 0 && (
            <>
              <img className="onb-logo" src="/icon.png" alt="" draggable={false} />
              <h1 className="serif">{tr('欢迎使用 Readly')}</h1>
              <p className="onb-lead">{tr('一个安静的电子书阅读器。花半分钟按你的习惯设置一下，之后随时可以在“设置”里修改。')}</p>
              <div className="onb-field">
                <span>{tr('语言')} · Language</span>
                <Segmented
                  value={settings.lang ?? 'zh'}
                  options={[
                    ['zh', '中文'],
                    ['en', 'English'],
                  ]}
                  onChange={v => updateSettings(s => ({ ...s, lang: v }))}
                />
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h2 className="serif">{tr('界面外观')}</h2>
              <p className="onb-lead">{tr('书架、设置这些界面的样子。')}</p>
              <div className="onb-field">
                <span>{tr('深浅色')}</span>
                <Segmented
                  value={settings.appTheme}
                  options={[
                    ['system', tr('跟随系统')],
                    ['light', tr('浅色')],
                    ['dark', tr('深色')],
                  ]}
                  onChange={v => setAppTheme(v)}
                />
              </div>
              <div className="onb-field">
                <span>{tr('主题色')}</span>
                <div className="swatches">
                  {ACCENTS.map(a => (
                    <button
                      key={a.id}
                      className={`swatch ${settings.accent === a.id ? 'on' : ''}`}
                      style={{ background: a.color }}
                      aria-label={tr(a.name)}
                      title={tr(a.name)}
                      onClick={() => updateSettings(s => ({ ...s, accent: a.id }))}
                    />
                  ))}
                  {isTauri && (
                    <button className={`chip ${settings.accent === 'system' ? 'on' : ''}`} onClick={() => updateSettings(s => ({ ...s, accent: 'system' }))}>
                      <span>{tr('系统取色')}</span>
                    </button>
                  )}
                </div>
              </div>
              <div className="onb-field">
                <span>
                  {tr('书架分类')}
                  <small>{tr('把书分到自己建的分类里，书多的时候好找')}</small>
                </span>
                <Toggle on={!!settings.shelfCategories} onChange={v => updateSettings(s => ({ ...s, shelfCategories: v }))} />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h2 className="serif">{tr('阅读偏好')}</h2>
              <p className="onb-lead">{tr('看书时的样子。阅读页里点屏幕中间，也能随时调整。')}</p>
              <div className="onb-preview" style={{ background: READER_THEMES[r.theme]?.bg, color: READER_THEMES[r.theme]?.fg, fontSize: Math.min(r.fontSize, 24), lineHeight: r.lineHeight }}>
                {tr('好的排版让人忘记排版本身，只记得故事。')}
              </div>
              <div className="onb-field column">
                <span>{tr('阅读背景')}</span>
                <div className="theme-dots">
                  {THEME_CHOICES.map(id => {
                    const t = READER_THEMES[id]
                    return (
                      <button
                        key={id}
                        className={`theme-dot ${r.theme === id ? 'on' : ''}`}
                        onClick={() => updateSettings(s => ({ ...s, reading: { ...s.reading, theme: id, ...(t.dark ? { darkTheme: id } : { dayTheme: id }) } }))}
                      >
                        <i style={{ background: t.bg, color: t.fg }}>{tr('文')}</i>
                        {tr(t.name)}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="onb-field">
                <span>{tr('字号')}</span>
                <Stepper value={r.fontSize} min={12} max={40} step={1} format={v => `${v}px`} onChange={v => updateSettings(s => ({ ...s, reading: { ...s.reading, fontSize: v } }))} />
              </div>
              <div className="onb-field">
                <span>{tr('翻页方式')}</span>
                <Segmented
                  value={b.flow}
                  options={[
                    ['paginated', tr('左右翻页')],
                    ['scrolled', tr('上下滚动')],
                  ]}
                  onChange={v => updateSettings(s => ({ ...s, behavior: { ...s.behavior, flow: v } }))}
                />
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <h2 className="serif">{tr('云同步（可选）')}</h2>
              <p className="onb-lead">{tr('用 WebDAV 网盘在手机和电脑之间同步书、进度和笔记。现在不想设置就直接跳过，以后在“同步”页里再开。')}</p>
              <div className="onb-field column">
                <span>{tr('服务商')}</span>
                <div className="chips">
                  {DAV_PRESETS.map(p => (
                    <button key={p.id} className={`chip ${preset?.id === p.id ? 'on' : ''}`} onClick={() => (setLinked(null), updateSync({ url: p.url }))}>
                      <span>{tr(p.name)}</span>
                    </button>
                  ))}
                  <button className={`chip ${!preset ? 'on' : ''}`} onClick={() => (setLinked(null), updateSync({ url: '' }))}>
                    <span>{tr('自定义')}</span>
                  </button>
                </div>
              </div>
              {!preset && (
                <input
                  className="field mono"
                  value={sync.url}
                  placeholder="https://…/dav/"
                  aria-label={tr('服务器地址')}
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={e => (setLinked(null), updateSync({ url: e.target.value.trim() }))}
                />
              )}
              <input
                className="field"
                value={sync.username}
                placeholder={tr('账号')}
                aria-label={tr('账号')}
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                onChange={e => (setLinked(null), updateSync({ username: e.target.value.trim() }))}
              />
              <input
                className="field"
                type="password"
                value={sync.password}
                placeholder={tr('密码（应用密码）')}
                aria-label={tr('密码（应用密码）')}
                autoComplete="off"
                onChange={e => (setLinked(null), updateSync({ password: e.target.value }))}
              />
              <div className="onb-sync-row">
                <button className="btn" disabled={!filled || testing || linked === true} onClick={connect}>
                  {linked && <IconCheck style={{ color: 'var(--sage)' }} />}
                  {testing ? tr('连接中…') : linked ? tr('已连接并开启同步') : linked === false ? tr('连接失败，重试') : tr('连接并开启同步')}
                </button>
                {linked === false && <small className="onb-err">{tr('请检查地址、账号和应用密码')}</small>}
              </div>
            </>
          )}
        </div>

        <div className="onb-nav">
          {step > 0 ? (
            <button className="btn ghost" onClick={() => go(step - 1)}>
              {tr('上一步')}
            </button>
          ) : (
            <button className="btn ghost" onClick={finish}>
              {tr('跳过')}
            </button>
          )}
          {step < STEPS - 1 ? (
            <button className="btn primary" onClick={() => go(step + 1)}>
              {tr('下一步')}
            </button>
          ) : (
            <button className="btn primary" onClick={finish}>
              {linked ? tr('开始阅读') : tr('先不同步，开始阅读')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
