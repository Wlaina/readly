/**
 * 更换封面：从书里的插图中挑一张，或从本地选一张图片；换过的可以一键恢复原封面。
 * 改的是书籍文件本身（原封面备份在文件里），会写回书籍文件夹、上传云端，其他设备同步后也跟着换。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import type { BookRecord } from '../lib/types'
import { epubImages, hasCustomCover } from '../lib/epubedit'
import { asCover } from '../lib/sources/download'
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

const urlOf = (img: Img) => URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.type }))

export default function CoverDialog({ rec, onClose }: { rec: BookRecord; onClose: () => void }) {
  const [images, setImages] = useState<{ img: Img; url: string; isCover: boolean }[] | null>(null)
  const [error, setError] = useState('')
  const [custom, setCustom] = useState(false)
  const [pick, setPick] = useState<Pick | null>(null)
  /** 横向跨页图：只用裁出来的正封面 */
  const [cropped, setCropped] = useState<Pick | null>(null)
  const [useCrop, setUseCrop] = useState(true)
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
        setImages(epubImages(bytes).map(i => ({ img: { bytes: i.bytes, type: i.type }, url: keep(urlOf(i)), isCover: i.isCover })))
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

  // 选中横向的图（例如跨页书封）时，顺便裁出正封面
  useEffect(() => {
    setCropped(null)
    if (!pick) return
    let alive = true
    ;(async () => {
      const bmp = await createImageBitmap(new Blob([pick.img.bytes as BlobPart])).catch(() => null)
      const wide = !!bmp && bmp.width / bmp.height >= 1.3
      bmp?.close()
      if (!wide) return
      const c = await asCover(pick.img)
      if (alive && c) setCropped({ img: c, url: keep(urlOf(c)), label: pick.label })
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick])

  const chosen = cropped && useCrop ? cropped : pick
  const candidates = useMemo(() => images?.filter(i => !i.isCover) ?? [], [images])
  const current = images?.find(i => i.isCover)

  const fromFile = async (f: File | undefined) => {
    if (!f) return
    const img = await shrink({ bytes: new Uint8Array(await f.arrayBuffer()), type: f.type || 'image/jpeg' })
    setPick({ img, url: keep(urlOf(img)), label: f.name })
  }

  const apply = async (img: Img | null) => {
    setBusy(true)
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
          <figure className={chosen ? '' : 'empty'}>
            {chosen ? <img src={chosen.url} alt="" /> : <span>{tr('在下面选一张')}</span>}
            <figcaption>{tr('换成')}</figcaption>
          </figure>
        </div>
        {cropped && (
          <label className="cover-crop">
            <input type="checkbox" checked={useCrop} onChange={e => setUseCrop(e.target.checked)} />
            {tr('这是一张跨页图：只用其中的正封面')}
          </label>
        )}

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
          <div className="cover-grid">
            {candidates.map((c, i) => (
              <button
                key={c.url}
                className={pick?.url === c.url ? 'on' : ''}
                onClick={() => setPick({ img: c.img, url: c.url, label: tr('插图 {n}', { n: i + 1 }) })}
              >
                <img src={c.url} alt="" loading="lazy" />
              </button>
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
          <button className="btn primary" disabled={busy || !chosen} onClick={() => chosen && apply(chosen.img)}>
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
