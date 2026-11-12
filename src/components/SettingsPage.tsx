import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { BUILTIN_FONTS, customFontOptions } from '../lib/fonts'
import { isTauri } from '../lib/storage'
import { haptic, isWindowsApp, setOpenWith } from '../lib/native'
import { ACCENTS, SHELF_SORTS } from '../lib/settings'
import { askConfirm } from '../lib/dialog'
import { setAppTheme } from '../lib/hooks'
import { foldersSupported } from '../lib/folders'
import FoldersCard from './FoldersCard'
import AboutCard from './AboutCard'
import { harmonize as resolvePreview, systemAccent } from '../lib/accent'
import { Card, Row, Segmented, Toggle } from './ui'
import { AppearanceControls, BehaviorControls } from './ReadingControls'
import { IconFont, IconTrash } from './icons'
import { tr } from '../lib/i18n'
import type { Motion } from '../lib/motion'
import { isAndroid } from '../lib/device'

type SectionId = 'general' | 'look' | 'shelf' | 'fonts' | 'reading' | 'behavior' | 'folders' | 'files' | 'about'

const SECTIONS: { id: SectionId; name: string; desc: string; show?: boolean }[] = [
  { id: 'general', name: '通用', desc: '语言、启动、触感与屏幕常亮' },
  { id: 'look', name: '界面', desc: '深浅色、主题色、背景、界面字体' },
  { id: 'shelf', name: '书架', desc: '分类、排序、显示的信息' },
  { id: 'reading', name: '阅读外观', desc: '主题、字体、字号、行距、边距' },
  { id: 'behavior', name: '翻页与操作', desc: '翻页方式、点击区域、页眉页脚' },
  { id: 'fonts', name: '字体管理', desc: '导入字体、使用已安装的字体' },
  { id: 'folders', name: '书籍文件夹', desc: '自动导入文件夹里的新书', show: foldersSupported },
  { id: 'files', name: '打开文件', desc: '“打开方式”与上传策略', show: isTauri },
  { id: 'about', name: '关于', desc: '版本信息' },
]

/** 本次运行期间记住看到哪个分类（切语言重新挂载后还在）；重新启动应用后回到第一项 */
let lastSection: SectionId = 'general'

type BookAnim = 'open' | 'fade' | 'emerge' | 'runes'
const BOOK_ANIMS: [BookAnim, string, string][] = [
  ['open', '翻开封面', '书架上的封面翻开并放大成书页，合上时原路收回'],
  ['emerge', '文字浮现', '书页先是一张空白的纸，文字带着微光一个个缓缓浮现出来'],
  ['runes', '符文飞入', '每个字像魔法符文一样旋转着从四周飞来，落定时闪一下光'],
  ['fade', '简单淡入', '书页直接淡入，最快'],
]

const MOTIONS: [Motion, string, string][] = [
  ['soft', '柔和渐变', '页面与卡片缓缓淡入，最安静'],
  ['slide', '轻推滑入', '新页面从右侧轻轻推入，层次感更强'],
  ['focus', '景深聚焦', '从轻微失焦到清晰，像镜头对焦'],
  ['magic', '魔法微光', '内容带着一点微光从朦胧中显现，像被施了魔法'],
  ['lively', '灵动弹性', '带一点回弹，更活泼'],
  ['off', '关闭', '关闭所有动画，适合较旧的设备'],
]

export default function SettingsPage() {
  const settings = useStore(s => s.settings)
  const customFonts = useStore(s => s.customFonts)
  const { updateSettings, importFont, removeFont } = useStore.getState()
  const fontInput = useRef<HTMLInputElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [localName, setLocalName] = useState('')
  const [demo, setDemo] = useState(0)
  const [bookDemo, setBookDemo] = useState(0)
  const [localTarget, setLocalTarget] = useState<'ui' | 'reading'>('reading')
  const sections = SECTIONS.filter(s => s.show !== false)
  // 系统取色实际取到的颜色，显示在按钮上方便和默认赤陶橙对比
  const [sysColor, setSysColor] = useState<string | null>(null)
  useEffect(() => {
    if (!isTauri) return
    systemAccent().then(c => setSysColor(c ? resolvePreview(c) : null))
  }, [])
  const [section, setSection] = useState<SectionId>(() => (sections.some(s => s.id === lastSection) ? lastSection : 'general'))
  /** 新内容从哪一侧进来：1 右侧（往后翻），-1 左侧（往前翻） */
  const [dir, setDir] = useState(1)

  const pick = (id: SectionId) => {
    if (id === section) return
    const from = sections.findIndex(s => s.id === section)
    const to = sections.findIndex(s => s.id === id)
    setDir(to > from ? 1 : -1)
    setSection((lastSection = id))
    scrollRef.current?.scrollTo({ top: 0 })
  }
  const sectionRef = useRef(section)
  sectionRef.current = section
  const pickRef = useRef(pick)
  pickRef.current = pick

  // 选中项下面的胶囊：量出当前按钮的位置，胶囊滑过去（和底部导航一样的手感）
  const [pill, setPill] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const place = (smooth: boolean) => {
      const el = nav.querySelector<HTMLElement>('button.on')
      if (!el) return
      setPill(p => (p && p.x === el.offsetLeft && p.y === el.offsetTop && p.w === el.offsetWidth && p.h === el.offsetHeight ? p : { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }))
      // 手机上把选中的分类滚到标签条中间（只横向滚标签条本身，不带动页面）
      if (nav.scrollWidth > nav.clientWidth + 1)
        nav.scrollTo({ left: el.offsetLeft - (nav.clientWidth - el.offsetWidth) / 2, behavior: smooth ? 'smooth' : ('instant' as ScrollBehavior) })
    }
    place(!!pill)
    const onResize = () => place(false)
    window.addEventListener('resize', onResize)
    // 字体加载完后按钮宽度会变
    document.fonts?.ready.then(() => place(false)).catch(() => {})
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, settings.uiFont])

  // 在内容区左右滑动：切到相邻的分类（内容跟着手指走一点，松手后换页）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    /** 0 未判定；1 正在横滑；2 与切换无关 */
    let mode: 0 | 1 | 2 = 2
    let sx = 0
    let sy = 0
    let dx = 0
    const ids = sections.map(s => s.id)
    const follow = (x: number, animate: boolean) => {
      const body = bodyRef.current
      if (!body) return
      body.style.transition = animate ? 'transform .24s cubic-bezier(.2, .8, .2, 1), opacity .24s' : 'none'
      body.style.transform = x ? `translate3d(${x}px, 0, 0)` : ''
      body.style.opacity = x ? String(Math.max(0.35, 1 - Math.abs(x) / 260)) : ''
    }
    const onStart = (e: TouchEvent) => {
      const t = e.target as Element | null
      mode = 2
      if (e.touches.length !== 1 || !t || t.closest('input, textarea, select, .no-swipe')) return
      // 手指下面有自己能横向滚动的内容：让它滚
      for (let n: Element | null = t; n && n !== el; n = n.parentElement)
        if (n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return
      mode = 0
      sx = e.touches[0].clientX
      sy = e.touches[0].clientY
      dx = 0
    }
    const onMove = (e: TouchEvent) => {
      if (mode === 2 || e.touches.length !== 1) return
      const x = e.touches[0].clientX - sx
      const y = e.touches[0].clientY - sy
      if (mode === 0) {
        if (Math.abs(x) > 12 && Math.abs(x) > Math.abs(y) * 1.6) mode = 1
        else if (Math.abs(y) > 10) return void (mode = 2)
        else return
      }
      if (e.cancelable) e.preventDefault()
      const i = ids.indexOf(sectionRef.current)
      const edge = (x > 0 && i === 0) || (x < 0 && i === ids.length - 1)
      dx = x
      // 已经是第一个/最后一个：只给一点阻尼，告诉你到头了
      follow(x * (edge ? 0.12 : 0.45), false)
    }
    const onEnd = () => {
      if (mode !== 1) return void (mode = 2)
      mode = 2
      const i = ids.indexOf(sectionRef.current)
      const next = dx < -56 ? i + 1 : dx > 56 ? i - 1 : i
      if (next !== i && next >= 0 && next < ids.length) {
        haptic(6)
        // 换页后新内容自己从对应一侧滑入，这里直接复位
        follow(0, false)
        pickRef.current(ids[next])
      } else follow(0, true)
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections.length])

  const uiFonts = [...BUILTIN_FONTS, ...customFontOptions(customFonts)]
  if (settings.uiFont.startsWith('local:')) uiFonts.push({ id: settings.uiFont, name: settings.uiFont.slice(6), family: null, kind: 'system' })
  const current = sections.find(s => s.id === section) ?? sections[0]

  return (
    <div className="page settings-page">
      <div className="page-inner settings-layout">
        <header className="page-head settings-head">
          <div>
            <h1>{tr('设置')}</h1>
            <div className="sub">{tr(current.desc)}</div>
          </div>
        </header>

        {/* 分类导航：电脑上是左侧栏，手机上是顶部可横滑的标签条；选中项下面有一枚会滑动的胶囊 */}
        <nav className="settings-nav glass" ref={navRef} aria-label={tr('设置分类')}>
          {pill && <span className="settings-pill" style={{ transform: `translate3d(${pill.x}px, ${pill.y}px, 0)`, width: pill.w, height: pill.h }} aria-hidden />}
          {sections.map(s => (
            <button key={s.id} className={s.id === section ? 'on' : ''} aria-current={s.id === section} onClick={() => pick(s.id)}>
              {tr(s.name)}
            </button>
          ))}
        </nav>

        <div className="settings-scroll" ref={scrollRef}>
          <div className={`settings-body ${dir > 0 ? 'from-right' : 'from-left'}`} key={section} ref={bodyRef}>
            {section === 'general' && (
              <Card>
                <Row label={tr('语言')} hint="中文 / English">
                  <Segmented
                    value={settings.lang ?? 'zh'}
                    options={[
                      ['zh', '中文'],
                      ['en', 'English'],
                    ]}
                    onChange={v => updateSettings(s => ({ ...s, lang: v }))}
                  />
                </Row>
                <Row label={tr('启动时继续阅读')} hint={tr('打开 Readly 时直接回到上次读的书')}>
                  <Toggle on={!!settings.resumeLast} onChange={v => updateSettings(s => ({ ...s, resumeLast: v }))} />
                </Row>
                <Row label={tr('触感反馈')} hint={tr('长按、滑动切换页面时轻微震动')}>
                  <Toggle on={settings.haptics ?? true} onChange={v => updateSettings(s => ({ ...s, haptics: v }))} />
                </Row>
                {isAndroid && (
                  <Row label={tr('阅读时屏幕常亮')} hint={tr('阅读页不会自动熄屏')}>
                    <Toggle on={settings.keepAwake ?? true} onChange={v => updateSettings(s => ({ ...s, keepAwake: v }))} />
                  </Row>
                )}
                <Row label={tr('新手引导')} hint={tr('重新走一遍第一次启动时的设置向导')}>
                  <button className="btn" onClick={() => updateSettings(s => ({ ...s, onboarded: false }))}>
                    {tr('再看一遍')}
                  </button>
                </Row>
              </Card>
            )}

            {section === 'look' && (
              <Card>
                <Row label={tr('深浅色')}>
                  <Segmented
                    value={settings.appTheme}
                    options={[
                      ['system', tr('跟随系统')],
                      ['light', tr('浅色')],
                      ['dark', tr('深色')],
                    ]}
                    onChange={v => setAppTheme(v)}
                  />
                </Row>
                <Row label={tr('动画效果')} hint={tr(MOTIONS.find(m => m[0] === (settings.motion ?? 'soft'))?.[2] ?? '')} />
                <div className="motion-pick">
                  <div className="chips">
                    {MOTIONS.map(([id, name]) => (
                      <button
                        key={id}
                        className={`chip ${(settings.motion ?? 'soft') === id ? 'on' : ''}`}
                        onClick={() => {
                          updateSettings(s => ({ ...s, motion: id }))
                          setDemo(d => d + 1)
                        }}
                      >
                        <span>{tr(name)}</span>
                      </button>
                    ))}
                  </div>
                  {/* 预览：只在这个小窗口里演示，不让整个界面跟着弹一下 */}
                  <button className="motion-demo" data-demo={settings.motion ?? 'soft'} onClick={() => setDemo(d => d + 1)} aria-label={tr('重播预览')} key={demo}>
                    <i className="demo-page">
                      <b />
                      <b />
                      <b />
                    </i>
                    <span>{tr('点按重播')}</span>
                  </button>
                </div>
                <Row label={tr('动画速度')} hint={tr('所有动画一起变慢或变快')}>
                  <Segmented
                    value={settings.motionSpeed ?? 'normal'}
                    options={[
                      ['slow', tr('舒缓')],
                      ['normal', tr('标准')],
                      ['fast', tr('利落')],
                    ]}
                    onChange={v => {
                      updateSettings(s => ({ ...s, motionSpeed: v }))
                      // 换完速度两个预览都重播一遍，马上能看到差别
                      setTimeout(() => {
                        setDemo(d => d + 1)
                        setBookDemo(d => d + 1)
                      }, 0)
                    }}
                  />
                </Row>
                <Row label={tr('打开书的动画')} hint={tr(BOOK_ANIMS.find(m => m[0] === (settings.bookAnim ?? 'open'))?.[2] ?? '')} />
                <div className="motion-pick">
                  <div className="chips">
                    {BOOK_ANIMS.map(([id, name]) => (
                      <button
                        key={id}
                        className={`chip ${(settings.bookAnim ?? 'open') === id ? 'on' : ''}`}
                        onClick={() => {
                          updateSettings(s => ({ ...s, bookAnim: id }))
                          setBookDemo(d => d + 1)
                        }}
                      >
                        <span>{tr(name)}</span>
                      </button>
                    ))}
                  </div>
                  <button className="motion-demo book-demo" data-demo={settings.bookAnim ?? 'open'} onClick={() => setBookDemo(d => d + 1)} aria-label={tr('重播预览')} key={`b${bookDemo}`}>
                    <i className="demo-page">
                      <b />
                      <b />
                      <b />
                      <b />
                    </i>
                    <i className="demo-cover" />
                    <span>{tr('点按重播')}</span>
                  </button>
                </div>
                <Row label={tr('主题色')} hint={tr('按钮、进度条、高亮等强调色；“系统取色”跟随安卓 12+ 壁纸取色或 Windows 强调色')}>
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
                    {/* 自选颜色：点开系统调色板 */}
                    <label className={`swatch swatch-custom ${settings.accent === 'custom' ? 'on' : ''}`} title={tr('自选颜色')} style={settings.accent === 'custom' ? { background: settings.accentCustom } : undefined}>
                      <input
                        type="color"
                        aria-label={tr('自选颜色')}
                        value={/^#[0-9a-f]{6}$/i.test(settings.accentCustom ?? '') ? settings.accentCustom : '#d97757'}
                        onClick={() => settings.accent !== 'custom' && updateSettings(s => ({ ...s, accent: 'custom' }))}
                        onChange={e => updateSettings(s => ({ ...s, accent: 'custom', accentCustom: e.target.value }))}
                      />
                    </label>
                    {isTauri && (
                      <button
                        className={`chip ${settings.accent === 'system' ? 'on' : ''}`}
                        title={sysColor ? tr('系统取到的颜色：{c}', { c: sysColor }) : tr('系统没有提供强调色')}
                        onClick={() => updateSettings(s => ({ ...s, accent: 'system' }))}
                      >
                        {sysColor && <i className="chip-swatch" style={{ background: sysColor }} />}
                        <span>{tr('系统取色')}</span>
                      </button>
                    )}
                  </div>
                </Row>
                <Row label={tr('莫奈流动背景')} hint={tr('书架等页面的柔和动态背景，阅读时自动停止')}>
                  <Toggle on={settings.monet} onChange={v => updateSettings(s => ({ ...s, monet: v }))} />
                </Row>
                {settings.monet && (
                  <Row label={tr('背景强度')}>
                    <Segmented
                      value={settings.monetLevel ?? 'standard'}
                      options={[
                        ['subtle', tr('淡雅')],
                        ['standard', tr('标准')],
                        ['vivid', tr('鲜明')],
                      ]}
                      onChange={v => updateSettings(s => ({ ...s, monetLevel: v }))}
                    />
                  </Row>
                )}
                <Row label={tr('玻璃质感')} hint={tr('导航栏、菜单等浮层的通透程度；越通透越能看到背后的流动背景')}>
                  <Segmented
                    value={settings.glass ?? 'clear'}
                    options={[
                      ['clear', tr('通透')],
                      ['standard', tr('标准')],
                      ['frosted', tr('磨砂')],
                    ]}
                    onChange={v => updateSettings(s => ({ ...s, glass: v }))}
                  />
                </Row>
                <Row label={tr('导航栏文字')} hint={tr('底部（电脑上是左侧）导航图标下面的文字')}>
                  <Toggle on={settings.dockLabels ?? true} onChange={v => updateSettings(s => ({ ...s, dockLabels: v }))} />
                </Row>
                <Row label={tr('界面字体')}>
                  <div className="chips">
                    {uiFonts.map(f => (
                      <button
                        key={f.id}
                        className={`chip ${settings.uiFont === f.id ? 'on' : ''}`}
                        style={f.family ? { fontFamily: f.family } : undefined}
                        onClick={() => updateSettings(s => ({ ...s, uiFont: f.id }))}
                      >
                        <span>{tr(f.name)}</span>
                      </button>
                    ))}
                  </div>
                </Row>
              </Card>
            )}

            {section === 'shelf' && (
              <Card>
                <Row label={tr('书架分类')} hint={tr('在书架顶部显示分类条；长按一本书或多选后可以把书放进分类。分类会随云同步到其他设备')}>
                  <Toggle on={!!settings.shelfCategories} onChange={v => updateSettings(s => ({ ...s, shelfCategories: v }))} />
                </Row>
                <Row label={tr('排序方式')}>
                  <div className="chips">
                    {SHELF_SORTS.map(([id, name]) => (
                      <button key={id} className={`chip ${(settings.shelfSort ?? 'recent') === id ? 'on' : ''}`} onClick={() => updateSettings(s => ({ ...s, shelfSort: id }))}>
                        <span>{tr(name)}</span>
                      </button>
                    ))}
                  </div>
                </Row>
                <Row label={tr('单本模式封面背景')} hint={tr('单本模式下，用当前这本书的封面做一层模糊渐变的背景')}>
                  <Toggle on={!!settings.shelfBackdrop} onChange={v => updateSettings(s => ({ ...s, shelfBackdrop: v }))} />
                </Row>
                <Row label={tr('封面下方显示')} hint={tr('多列书架里每本书下面显示哪些信息')}>
                  <Segmented
                    value={settings.shelfInfo ?? 'full'}
                    options={[
                      ['full', tr('书名与进度')],
                      ['title', tr('只有书名')],
                      ['cover', tr('只有封面')],
                    ]}
                    onChange={v => updateSettings(s => ({ ...s, shelfInfo: v }))}
                  />
                </Row>
              </Card>
            )}

            {section === 'reading' && (
              <Card>
                <AppearanceControls />
              </Card>
            )}

            {section === 'behavior' && (
              <Card>
                <BehaviorControls />
              </Card>
            )}

            {section === 'fonts' && (
              <Card>
                <Row label={tr('导入字体文件')} hint={tr('支持 ttf / otf / woff / woff2，导入后可用作界面或阅读字体')}>
                  <button className="btn" onClick={() => fontInput.current?.click()}>
                    <IconFont />
                    {tr('选择字体')}
                  </button>
                </Row>
                {customFonts.map(f => (
                  <Row key={f.id} label={<span style={{ fontFamily: `"Readly Custom ${f.id}"` }}>{f.name}</span>} hint={f.fileName}>
                    <button
                      className="icon-btn"
                      aria-label={tr('删除 {name}', { name: f.name })}
                      onClick={async () => (await askConfirm({ title: tr('删除字体「{name}」？', { name: f.name }), okText: tr('删除'), danger: true })) && removeFont(f.id)}
                    >
                      <IconTrash />
                    </button>
                  </Row>
                ))}
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <div className="row-label">
                    {tr('使用已安装的字体')}
                    <span className="hint">{tr('输入系统里已有的字体名，例如“霞鹜文楷”')}</span>
                    <input className="field" style={{ marginTop: 8 }} value={localName} placeholder={tr('字体名称')} onChange={e => setLocalName(e.target.value)} />
                  </div>
                  <div className="row-control">
                    <Segmented value={localTarget} options={[['reading', tr('阅读')], ['ui', tr('界面')]]} onChange={setLocalTarget} />
                    <button
                      className="btn"
                      disabled={!localName.trim()}
                      onClick={() => {
                        const id = `local:${localName.trim()}`
                        updateSettings(s => (localTarget === 'ui' ? { ...s, uiFont: id } : { ...s, reading: { ...s.reading, font: id } }))
                        useStore.getState().showToast(tr(localTarget === 'ui' ? '已将界面字体设为 {name}' : '已将阅读字体设为 {name}', { name: localName.trim() }))
                        setLocalName('')
                      }}
                    >
                      {tr('应用')}
                    </button>
                  </div>
                </div>
                <input
                  ref={fontInput}
                  type="file"
                  accept=".ttf,.otf,.woff,.woff2"
                  hidden
                  onChange={e => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    if (f) importFont(f)
                  }}
                />
              </Card>
            )}

            {section === 'folders' && <FoldersCard />}

            {section === 'files' && (
              <Card>
                <Row label={tr('从系统“打开方式”打开书籍时')} hint={tr('新书加入书架后，是否上传到云端')}>
                  <Segmented
                    value={settings.openFile}
                    options={[
                      ['ask', tr('每次询问')],
                      ['upload', tr('上传云端')],
                      ['local', tr('仅本机')],
                    ]}
                    onChange={v => updateSettings(s => ({ ...s, openFile: v }))}
                  />
                </Row>
                {isWindowsApp && (
                  <Row label={tr('加入右键“打开方式”')} hint={tr('安装版已自动注册；便携版移动位置后需要重新加入')}>
                    <div className="btn-row">
                      <button
                        className="btn"
                        onClick={() =>
                          setOpenWith(false)
                            .then(() => useStore.getState().showToast(tr('已从“打开方式”中移除')))
                            .catch(e => useStore.getState().showToast(tr('移除失败：{e}', { e: String(e) })))
                        }
                      >
                        {tr('移除')}
                      </button>
                      <button
                        className="btn primary"
                        onClick={() =>
                          setOpenWith(true)
                            .then(() => useStore.getState().showToast(tr('已加入 .epub / .txt 的“打开方式”')))
                            .catch(e => useStore.getState().showToast(tr('注册失败：{e}', { e: String(e) })))
                        }
                      >
                        {tr('加入')}
                      </button>
                    </div>
                  </Row>
                )}
              </Card>
            )}

            {section === 'about' && <AboutCard />}
          </div>
        </div>
      </div>
    </div>
  )
}
