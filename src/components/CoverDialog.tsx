/**
 * 更换封面：从书里的插图中挑一张（按卷分组），或从本地选一张图片；选中后可以拖动、缩放，框出要当封面的部分。
 * 换过的可以一键恢复原封面。
 * 改的是书籍文件本身（原封面备份在文件里），会写回书籍文件夹、上传云端，其他设备同步后也跟着换。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import type { BookRecord } from '../lib/types'
import { epubImages, hasCustomCover } from '../lib/epubedit'
import { frontCoverSpan } from '../lib/sources/download'
import { tr } from '../lib/i18n'
import { BookCover } from './BookCover'

type Img = { bytes: Uint8Array; type: string }
type Pick = { img: Img; url: string; label: string }

/** 本地照片可能很大：长边超过 2400 或超过 2MB 时缩小、转成 JPEG */
async function shrink(img: Img): Promise<Img> {
  try {
    const bmp = await createImageBitmap(new Blob([img.bytes as BlobPart], { type: img.type }))
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height))
    if (scale === 1 && img.bytes.length < 2 * 1024 * 1024 && /jpeg|png|webp|gif/.test(img.type)) {
      bmp.close()
      return img
    }
    const w = Math.round(bmp.width * scale)
    const h = Math.round(bmp.height * scale)
    const canvas = new OffscreenCanvas(w, h)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg' }
  } catch {
    return img
  }
}

/** 卷名前面带着书名的（“书名 5”）只显示后面的部分 */
const volLabel = (t: string, book: string) => {
  const rest = book && t.startsWith(book) && t.length > book.length ? t.slice(book.length).trim() : t
  return /^\d+(\.\d+)?$/.test(rest) ? tr('第 {n} 卷', { n: rest }) : rest
}

const urlOf = (img: Img) => URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.type }))

/** 封面框的大小（宽 : 高 = 1 : 1.42，和书架上的封面一样） */
const FW = 200
const FH = Math.round(FW * 1.42)
const MAX_ZOOM = 6
type View = { s: number; x: number; y: number }
type Crop = { view: View; w: number; h: number }

/**
 * 裁封面：图片铺满封面框，可以拖动、滚轮 / 双指 / 滑块缩放，选出要当封面的部分。
 * 横向的跨页图一开始就对准正封面（日本轻小说从右往左读，正封面在左边）
 */
function CropBox({ pick, onCrop }: { pick: Pick; onCrop: (c: Crop | null) => void }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 })
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const boxRef = useRef<HTMLDivElement>(null)
  const min = size ? Math.max(FW / size.w, FH / size.h) : 1

  /** 图片要盖满封面框：不能拖出空白，也不能缩得比框小 */
  const clamp = (v: View): View => {
    if (!size) return v
    const s = Math.min(Math.max(v.s, min), min * MAX_ZOOM)
    return { s, x: Math.min(0, Math.max(FW - size.w * s, v.x)), y: Math.min(0, Math.max(FH - size.h * s, v.y)) }
  }
  /** 以框里的 (cx, cy) 为中心缩放到 s */
  const zoomAt = (v: View, s: number, cx: number, cy: number) => clamp({ s, x: cx - ((cx - v.x) * s) / v.s, y: cy - ((cy - v.y) * s) / v.s })

  useEffect(() => {
    let alive = true
    setSize(null)
    ;(async () => {
      const bmp = await createImageBitmap(new Blob([pick.img.bytes as BlobPart], { type: pick.img.type })).catch(() => null)
      if (!bmp) return
      if (!alive) return bmp.close()
      const { width: w, height: h } = bmp
      const s = Math.max(FW / w, FH / h)
      let x = (FW - w * s) / 2
      if (w / h >= 1.3) {
        // 跨页图：对准自动找到的正封面
        const [l, r] = frontCoverSpan(bmp)
        x = Math.min(0, Math.max(FW - w * s, FW / 2 - ((l + r) / 2) * s))
      }
      bmp.close()
      if (!alive) return
      setSize({ w, h })
      setView({ s, x, y: (FH - h * s) / 2 })
    })()
    return () => {
      alive = false
    }
  }, [pick])

  useEffect(() => onCrop(size ? { view, w: size.w, h: size.h } : null), [view, size, onCrop])

  // 滚轮缩放（要阻止页面滚动，所以用原生监听）
  const zoomRef = useRef(zoomAt)
  zoomRef.current = zoomAt
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      setView(v => zoomRef.current(v, v.s * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }
  const onMove = (e: React.PointerEvent) => {
    const ps = pointers.current
    const prev = ps.get(e.pointerId)
    if (!prev) return
    const now = { x: e.clientX, y: e.clientY }
    if (ps.size >= 2) {
      // 双指：按两指距离的变化缩放，以两指中点为中心
      const other = [...ps.entries()].find(([id]) => id !== e.pointerId)![1]
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y)
      const d1 = Math.hypot(now.x - other.x, now.y - other.y)
      ps.set(e.pointerId, now)
      const r = boxRef.current!.getBoundingClientRect()
      const cx = (now.x + other.x) / 2 - r.left
      const cy = (now.y + other.y) / 2 - r.top
      if (d0 > 0) setView(v => zoomAt(v, (v.s * d1) / d0, cx, cy))
      return
    }
    ps.set(e.pointerId, now)
    setView(v => clamp({ ...v, x: v.x + now.x - prev.x, y: v.y + now.y - prev.y }))
  }
  const onUp = (e: React.PointerEvent) => void pointers.current.delete(e.pointerId)

  return (
    <div className="cover-cropper">
      <div
        ref={boxRef}
        className="cover-crop-box"
        style={{ width: FW, height: FH }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {size && (
          <img
            src={pick.url}
            alt=""
            draggable={false}
            style={{ width: size.w * view.s, height: size.h * view.s, transform: `translate(${view.x}px, ${view.y}px)` }}
          />
        )}
      </div>
      <input
        className="cover-zoom"
        type="range"
        min={0}
        max={1}
        step={0.001}
        aria-label={tr('缩放')}
        disabled={!size}
        value={size ? Math.log(view.s / min) / Math.log(MAX_ZOOM) : 0}
        onChange={e => setView(v => zoomAt(v, min * Math.pow(MAX_ZOOM, Number(e.target.value)), FW / 2, FH / 2))}
      />
    </div>
  )
}

/** 按裁剪框截出封面；几乎是整张图时直接用原图（不重新压缩） */
async function cropImage(pick: Pick, c: Crop): Promise<Img> {
  const { s, x, y } = c.view
  const sx = -x / s
  const sy = -y / s
  const sw = FW / s
  const sh = FH / s
  if (sw >= c.w * 0.97 && sh >= c.h * 0.97) return pick.img
  const bmp = await createImageBitmap(new Blob([pick.img.bytes as BlobPart], { type: pick.img.type }))
  // 输出最高 2000 像素高，够清楚又不会太大
  const k = Math.min(1, 2000 / sh)
  const ow = Math.max(1, Math.round(sw * k))
  const oh = Math.max(1, Math.round(sh * k))
  const canvas = new OffscreenCanvas(ow, oh)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, ow, oh)
  bmp.close()
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg' }
}

export default function CoverDialog({ rec, onClose }: { rec: BookRecord; onClose: () => void }) {
  const [images, setImages] = useState<{ img: Img; url: string; isCover: boolean; group: string | null }[] | null>(null)
  const [error, setError] = useState('')
  const [custom, setCustom] = useState(false)
  const [pick, setPick] = useState<Pick | null>(null)
  /** 裁剪框现在框住的部分 */
  const crop = useRef<Crop | null>(null)
  const onCrop = useMemo(() => (c: Crop | null) => void (crop.current = c), [])
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const urls = useRef<string[]>([])
  const keep = (u: string) => (urls.current.push(u), u)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const bytes = await useStore.getState().loadBookFile(rec)
        if (!alive) return
        setCustom(hasCustomCover(bytes))
        setImages(epubImages(bytes).map(i => ({ img: { bytes: i.bytes, type: i.type }, url: keep(urlOf(i)), isCover: i.isCover, group: i.group })))
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      alive = false
      window.removeEventListener('keydown', onKey)
      for (const u of urls.current) URL.revokeObjectURL(u)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.hash])

  const candidates = useMemo(() => images?.filter(i => !i.isCover) ?? [], [images])
  /** 按卷分组（分不出卷的书只有一组，不显示组名）；正文里没用到的图放在最后“其他图片” */
  const groups = useMemo(() => {
    const out: { title: string; items: typeof candidates }[] = []
    for (const c of candidates) {
      const title = c.group ?? tr('其他图片')
      const last = out[out.length - 1]
      if (last && last.title === title) last.items.push(c)
      else out.push({ title, items: [c] })
    }
    return out
  }, [candidates])
  const showGroups = groups.length > 1 || !!groups[0]?.title
  const current = images?.find(i => i.isCover)

  const fromFile = async (f: File | undefined) => {
    if (!f) return
    const img = await shrink({ bytes: new Uint8Array(await f.arrayBuffer()), type: f.type || 'image/jpeg' })
    setPick({ img, url: keep(urlOf(img)), label: f.name })
  }

  const apply = async (p: Pick | null) => {
    setBusy(true)
    const img = p ? (crop.current ? await cropImage(p, crop.current).catch(() => p.img) : p.img) : null
    const ok = await useStore.getState().setBookCover(rec.hash, img)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <>
      <div className="scrim dim fade-in" style={{ zIndex: 120 }} onClick={onClose} />
      <div className="dialog cover-dialog glass" role="dialog" aria-modal="true" aria-label={tr('更换封面')}>
        <h2>{tr('更换封面')}</h2>
        <div className="cover-compare">
          <figure>
            {current ? <img src={current.url} alt="" /> : <BookCover rec={rec} />}
            <figcaption>{tr('现在')}</figcaption>
          </figure>
          <span className="cover-arrow" aria-hidden>
            →
          </span>
          <figure className={pick ? 'cropping' : 'empty'}>
            {pick ? <CropBox pick={pick} onCrop={onCrop} /> : <span>{tr('在下面选一张')}</span>}
            <figcaption>{pick ? tr('拖动选位置，滚轮、双指或滑块缩放') : tr('换成')}</figcaption>
          </figure>
        </div>

        <div className="cover-pick-head">
          <span>{tr('书里的插图')}</span>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            {tr('从本地选择图片…')}
          </button>
        </div>
        {error ? (
          <p className="cover-empty">{tr('读不出书里的图片：{e}', { e: error })}</p>
        ) : !images ? (
          <p className="cover-empty">{tr('正在读取…')}</p>
        ) : !candidates.length ? (
          <p className="cover-empty">{tr('这本书里没有插图，可以从本地选择图片。')}</p>
        ) : (
          <div className="cover-groups">
            {groups.map((g, gi) => (
              <section key={gi}>
                {showGroups && <h3 className="cover-group-title">{volLabel(g.title, rec.title) || tr('开头')}</h3>}
                <div className="cover-grid">
                  {g.items.map(c => (
                    <button key={c.url} className={pick?.url === c.url ? 'on' : ''} onClick={() => setPick({ img: c.img, url: c.url, label: g.title })}>
                      <img src={c.url} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        <p className="book-info-note">
          {tr('会直接修改书籍文件里的封面（原封面保存在文件里，随时可以恢复），并同步到其他设备和书籍文件夹。')}
        </p>
        <div className="btn-row cover-actions">
          {custom && (
            <button className="btn" disabled={busy} onClick={() => apply(null)}>
              {tr('恢复原封面')}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            {tr('取消')}
          </button>
          <button className="btn primary" disabled={busy || !pick} onClick={() => pick && apply(pick)}>
            {busy ? tr('保存中…') : tr('使用这张')}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={e => {
            void fromFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>
    </>
  )
}
