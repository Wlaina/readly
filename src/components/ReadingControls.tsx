import { useStore } from '../lib/store'
import {
  DARK_THEMES as DARK,
  DEFAULT_STATUS,
  LIGHT_THEMES as LIGHT,
  readerTheme,
  STATUS_ITEMS,
  type Behavior,
  type ReaderThemeId,
  type ReadingStyle,
  type StatusConfig,
  type StatusItem,
  type StatusZone,
} from '../lib/settings'
import { BOOK_FONT, BUILTIN_FONTS, customFontOptions } from '../lib/fonts'
import { isAndroid } from '../lib/device'
import { hasNativeBrightness } from '../lib/native'
import { Row, Segmented, Stepper, Toggle } from './ui'
import { tr } from '../lib/i18n'

const ZONE_LABEL: Record<StatusZone, string> = { tl: '左上', tc: '上中', tr: '右上', bl: '左下', bc: '下中', br: '右下' }
const zoneLabel = (z: StatusZone) => tr(ZONE_LABEL[z])

/** 区域选择：一张迷你页面，点哪个角就放到哪里 */
function ZonePicker({ value, onChange, disabled }: { value: StatusZone; onChange: (z: StatusZone) => void; disabled?: boolean }) {
  return (
    <div className={`zone-picker ${disabled ? 'disabled' : ''}`} role="radiogroup" aria-label={tr('显示位置')}>
      {(['tl', 'tc', 'tr'] as StatusZone[]).map(z => (
        <button key={z} role="radio" aria-checked={value === z} aria-label={zoneLabel(z)} className={value === z ? 'on' : ''} onClick={() => onChange(z)} />
      ))}
      <span className="zone-page" aria-hidden />
      {(['bl', 'bc', 'br'] as StatusZone[]).map(z => (
        <button key={z} role="radio" aria-checked={value === z} aria-label={zoneLabel(z)} className={value === z ? 'on' : ''} onClick={() => onChange(z)} />
      ))}
    </div>
  )
}

/** 页眉页脚：每项信息一行，各自开关、各自选位置 */
function StatusEditor({ b, set }: { b: Behavior; set: (patch: Partial<Behavior>) => void }) {
  const status = b.status ?? DEFAULT_STATUS
  const update = (item: Exclude<StatusItem, 'none'>, patch: Partial<StatusConfig[typeof item]>) =>
    set({ status: { ...status, [item]: { ...status[item], ...patch } } })
  return (
    <>
      {STATUS_ITEMS.filter(([k]) => k !== 'none').map(([k, label]) => {
        const item = k as Exclude<StatusItem, 'none'>
        const cfg = status[item]
        return (
          <div key={item} className="row status-row">
            <div className="row-label">
              {tr(label)}
              <span className="hint">{cfg.on ? tr('显示在{zone}', { zone: zoneLabel(cfg.zone) }) : tr('不显示')}</span>
            </div>
            <div className="row-control">
              <ZonePicker value={cfg.zone} disabled={!cfg.on} onChange={zone => update(item, { zone, on: true })} />
              <Toggle on={cfg.on} onChange={on => update(item, { on })} />
            </div>
          </div>
        )
      })}
      <Row label={tr('页眉页脚字号')}>
        <Segmented
          value={b.statusSize ?? 'md'}
          options={[
            ['sm', tr('小')],
            ['md', tr('中')],
            ['lg', tr('大')],
          ]}
          onChange={v => set({ statusSize: v })}
        />
      </Row>
    </>
  )
}

function ThemePicker({ value, onChange, dark = false, style }: { value: ReaderThemeId; onChange: (v: ReaderThemeId) => void; dark?: boolean; style: ReadingStyle }) {
  // “自定义”放在最后；夜间背景那一行只在自定义的颜色本身是深色时才列出它
  const ids: ReaderThemeId[] = dark ? [...DARK, ...(readerTheme(style, 'custom').dark ? (['custom'] as ReaderThemeId[]) : [])] : [...LIGHT, ...DARK, 'custom']
  return (
    <div className="theme-dots">
      {ids.map(id => {
        const t = readerTheme(style, id)
        return (
          <button key={id} className={`theme-dot ${value === id ? 'on' : ''}`} onClick={() => onChange(id)}>
            <i style={{ background: t.bg, color: t.fg }}>{tr('文')}</i>
            {tr(t.name)}
          </button>
        )
      })}
    </div>
  )
}

/** 取色器：一个圆形色块，点开系统的调色板 */
function ColorInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="color-input">
      <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#888888'} onChange={e => onChange(e.target.value)} aria-label={label} />
      <span>{label}</span>
    </label>
  )
}

/** 屏幕亮度：跟随系统，或者拖动滑块自己定 */
function BrightnessRow({ value, set }: { value: number; set: (v: number) => void }) {
  const native = hasNativeBrightness()
  const custom = value >= 0
  return (
    <div className="row">
      <div className="row-label">
        {tr('屏幕亮度')}
        <span className="hint">
          {native ? tr('只在阅读时生效；也可以在阅读页长按日间/夜间按钮后左右滑动调节') : tr('只在阅读时生效；电脑上只能在系统亮度的基础上调暗')}
        </span>
        {custom && (
          <input
            className="no-sheet-drag"
            style={{ marginTop: 6 }}
            type="range"
            min={0.02}
            max={1}
            step={0.01}
            value={value}
            onChange={e => set(Number(e.target.value))}
            aria-label={tr('屏幕亮度')}
          />
        )}
      </div>
      <div className="row-control">
        <Segmented
          value={custom ? 'custom' : 'system'}
          options={[
            ['system', tr('跟随系统')],
            ['custom', custom ? `${Math.round(value * 100)}%` : tr('自定')],
          ]}
          onChange={v => set(v === 'system' ? -1 : value >= 0 ? value : native ? 0.5 : 0.8)}
        />
      </div>
    </div>
  )
}

export function useReading() {
  const reading = useStore(s => s.settings.reading)
  const set = (patch: Partial<ReadingStyle>) =>
    useStore.getState().updateSettings(s => ({ ...s, reading: { ...s.reading, ...patch } }))
  return [reading, set] as const
}

export function useBehavior() {
  const behavior = useStore(s => s.settings.behavior)
  const set = (patch: Partial<Behavior>) =>
    useStore.getState().updateSettings(s => ({ ...s, behavior: { ...s.behavior, ...patch } }))
  return [behavior, set] as const
}

/** 阅读外观：compact 用于阅读器内的快捷面板 */
export function AppearanceControls({ compact = false }: { compact?: boolean }) {
  const [r, set] = useReading()
  const custom = useStore(s => s.customFonts)
  const fonts = [BOOK_FONT, ...BUILTIN_FONTS, ...customFontOptions(custom)]
  if (r.font.startsWith('local:')) fonts.push({ id: r.font, name: r.font.slice(6), family: null, kind: 'system' })
  // 选中的背景：深色的记为“夜间背景”，浅色的记为“日间背景”，阅读页的月亮按钮就在这两者之间切换
  const pickTheme = (v: ReaderThemeId) => set(readerTheme(r, v).dark ? { theme: v, darkTheme: v } : { theme: v, dayTheme: v })
  const customTheme = readerTheme(r, 'custom')
  /** 改自定义颜色：深浅变了的话，把“日间/夜间背景”的归属也跟着改，月亮按钮才切得对 */
  const setCustom = (patch: Partial<ReadingStyle>) => {
    const next = { ...r, ...patch }
    const dark = readerTheme(next, 'custom').dark
    const fix: Partial<ReadingStyle> = {}
    if (next.theme === 'custom') {
      if (dark) fix.darkTheme = 'custom'
      else fix.dayTheme = 'custom'
    }
    // 自定义从深色改成浅色后，它不能再当夜间背景（反过来同理）
    if (!dark && next.darkTheme === 'custom') fix.darkTheme = 'night'
    if (dark && next.dayTheme === 'custom') fix.dayTheme = 'parchment'
    set({ ...patch, ...fix })
  }

  return (
    <>
      <Row label={tr('阅读背景')} hint={compact ? undefined : tr('只影响阅读页；书架、设置等界面的深浅色在“界面”里设置')}>
        <ThemePicker value={r.theme} onChange={pickTheme} style={r} />
      </Row>
      {r.theme === 'custom' && (
        <Row label={tr('自定义颜色')} hint={compact ? undefined : tr('自己挑背景色和文字色；深色背景会自动算作夜间背景')}>
          <div className="color-inputs">
            <ColorInput label={tr('背景')} value={customTheme.bg} onChange={v => setCustom({ customBg: v })} />
            <ColorInput label={tr('文字')} value={customTheme.fg} onChange={v => setCustom({ customFg: v })} />
          </div>
        </Row>
      )}
      {!compact && (
        <Row label={tr('夜间背景')} hint={tr('阅读页的日间/夜间按钮会切换到它，再按一次回到日间背景')}>
          <ThemePicker value={r.darkTheme} onChange={v => set({ darkTheme: v })} dark style={r} />
        </Row>
      )}
      <BrightnessRow value={r.brightness ?? -1} set={v => set({ brightness: v })} />
      <Row label={tr('阅读字体')}>
        <div className="chips">
          {fonts.map(f => (
            <button
              key={f.id}
              className={`chip ${r.font === f.id ? 'on' : ''}`}
              style={f.family ? { fontFamily: f.family } : undefined}
              onClick={() => set({ font: f.id })}
            >
              <span>{tr(f.name)}</span>
            </button>
          ))}
        </div>
      </Row>
      <Row label={tr('字号')}>
        <Stepper value={r.fontSize} min={12} max={40} step={1} format={v => `${v}px`} onChange={v => set({ fontSize: v })} />
      </Row>
      <Row label={tr('行距')}>
        <Stepper value={r.lineHeight} min={1.2} max={2.8} step={0.1} format={v => v.toFixed(1)} onChange={v => set({ lineHeight: v })} />
      </Row>
      <Row label={tr('段间距')}>
        <Stepper value={r.paragraphSpacing} min={0} max={2} step={0.1} format={v => `${v.toFixed(1)}em`} onChange={v => set({ paragraphSpacing: v })} />
      </Row>
      <Row label={tr('首行缩进')}>
        <Segmented value={r.textIndent} options={[[0, tr('无')], [1, tr('1 字')], [2, tr('2 字')]]} onChange={v => set({ textIndent: v })} />
      </Row>
      <Row label={tr('左右边距')}>
        <Stepper value={r.marginX} min={0} max={24} step={1} format={v => `${v}%`} onChange={v => set({ marginX: v })} />
      </Row>
      {!compact && (
        <>
          <Row label={tr('字间距')}>
            <Stepper value={r.letterSpacing} min={-0.05} max={0.3} step={0.01} format={v => `${v.toFixed(2)}em`} onChange={v => set({ letterSpacing: v })} />
          </Row>
          <Row label={tr('上下边距')}>
            <Stepper value={r.marginY} min={0} max={120} step={4} format={v => `${v}px`} onChange={v => set({ marginY: v })} />
          </Row>
          <Row label={tr('最大行宽')} hint={tr('大屏上每栏文字的最大宽度')}>
            <Stepper value={r.maxWidth} min={480} max={1600} step={40} format={v => `${v}`} onChange={v => set({ maxWidth: v })} />
          </Row>
        </>
      )}
      <Row label={tr('宽屏双栏')} hint={tr('窗口足够宽时并排显示两页')}>
        <Toggle on={r.columns === 2} onChange={v => set({ columns: v ? 2 : 1 })} />
      </Row>
      <Row label={tr('两端对齐')}>
        <Toggle on={r.justify} onChange={v => set({ justify: v })} />
      </Row>
      {!compact && (
        <>
          <Row label={tr('自动断词')} hint={tr('只对英文等西文有效')}>
            <Toggle on={r.hyphenate} onChange={v => set({ hyphenate: v })} />
          </Row>
          <Row label={tr('覆盖书籍排版')} hint={tr('使用上面的行距、段距、缩进，忽略书籍自带样式（TXT 始终生效）')}>
            <Toggle on={r.overrideLayout} onChange={v => set({ overrideLayout: v })} />
          </Row>
          <Row label={tr('覆盖书籍颜色')} hint={tr('统一文字与背景色，避免夜间模式出现刺眼的白底')}>
            <Toggle on={r.overrideColors} onChange={v => set({ overrideColors: v })} />
          </Row>
        </>
      )}
    </>
  )
}

export function BehaviorControls() {
  const [b, set] = useBehavior()
  return (
    <>
      <Row label={tr('翻页方式')}>
        <Segmented value={b.flow} options={[['paginated', tr('左右翻页')], ['scrolled', tr('上下滚动')]]} onChange={v => set({ flow: v })} />
      </Row>
      {b.flow === 'paginated' && (
        <Row label={tr('翻页动画')}>
          <Toggle on={b.animated} onChange={v => set({ animated: v })} />
        </Row>
      )}
      <Row label={tr('点击翻页')} hint={tr('中间区域始终用于呼出菜单')}>
        <Toggle on={b.tapToTurn} onChange={v => set({ tapToTurn: v })} />
      </Row>
      {b.tapToTurn && (
        <Row label={tr('点击区域')}>
          <Segmented value={b.tapMode} options={[['sides', tr('左上页 右下页')], ['next', tr('两侧都下一页')]]} onChange={v => set({ tapMode: v })} />
        </Row>
      )}
      <Row label={tr('鼠标滚轮翻页')} hint={tr('分页模式下滚动滚轮即翻页')}>
        <Toggle on={b.wheelTurn} onChange={v => set({ wheelTurn: v })} />
      </Row>
      <Row label={tr('页眉页脚')} hint={tr('阅读时在页面上下显示的信息')}>
        <Toggle on={b.showStatusBar} onChange={v => set({ showStatusBar: v })} />
      </Row>
      {b.showStatusBar && <StatusEditor b={b} set={set} />}
      <Row label={tr('工具栏显示进度滑块')} hint={tr('在阅读工具栏里显示可拖动的全书进度条；关闭后用目录和章节切换，不容易误触')}>
        <Toggle on={!!b.showSlider} onChange={v => set({ showSlider: v })} />
      </Row>
      {isAndroid && (
        <Row label={tr('沉浸阅读')} hint={tr('阅读时隐藏状态栏和底部小白条，从屏幕边缘滑动可临时唤出')}>
          <Toggle on={b.immersive} onChange={v => set({ immersive: v })} />
        </Row>
      )}
      {isAndroid && (
        <Row label={tr('音量键翻页')} hint={tr('阅读时音量减翻到下一页、音量加翻到上一页；离开阅读页后恢复调节音量')}>
          <Toggle on={!!b.volumeKeys} onChange={v => set({ volumeKeys: v })} />
        </Row>
      )}
      {!isAndroid && (
        <Row label={tr('自动隐藏鼠标')}>
          <Toggle on={b.autoHideCursor} onChange={v => set({ autoHideCursor: v })} />
        </Row>
      )}
      <Row label={tr('进出书籍时同步进度')} hint={tr('打开书前拉取另一台设备的最新进度并跳转；退出或切到后台时立刻上传')}>
        <Toggle on={b.syncOnOpen} onChange={v => set({ syncOnOpen: v })} />
      </Row>
    </>
  )
}
