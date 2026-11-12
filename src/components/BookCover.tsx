import { memo, useEffect, useRef, useState } from 'react'
import type { BookRecord } from '../lib/types'
import { IconCheck } from './icons'
import { genColors, loadCover, onCoverReady, peekCover } from '../lib/covers'
import { tr } from '../lib/i18n'

/**
 * 书籍封面：进入视口附近才读取；没有封面时用书名生成一张。
 * large：单本模式用的大图；其余用缩略图。
 */
export const BookCover = memo(function BookCover({
  rec,
  selected,
  selecting,
  large = false,
}: {
  rec: BookRecord
  selected?: boolean
  selecting?: boolean
  large?: boolean
}) {
  const size = large ? 'large' : 'thumb'
  const [url, setUrl] = useState(() => peekCover(rec.hash, size))
  const ref = useRef<HTMLDivElement>(null)
  /** 这张图是刚读出来的（第一次出现时轻轻淡入），而不是早就准备好的 */
  const fresh = useRef(false)
  /** 记录说有封面，但文件读不到：退回生成的封面 */
  const [missing, setMissing] = useState(false)
  // 封面被更新（编辑信息、文件被外部修改、同步后补封面）或换了尺寸：丢掉旧图重新读取
  const stamp = `${rec.hash}|${rec.coverRev ?? 0}|${size}`
  const last = useRef(stamp)
  useEffect(() => {
    if (last.current === stamp) return
    last.current = stamp
    fresh.current = false
    setMissing(false)
    setUrl(peekCover(rec.hash, size))
  }, [stamp, rec.hash, size])
  useEffect(() => {
    if (url || !rec.hasCover) return
    const el = ref.current
    if (!el) return
    let alive = true
    // 别处已经把这张封面读好了（例如轮播提前准备相邻的几本）：直接换上，不用等它滚进屏幕
    const off = onCoverReady(rec.hash, size, u => alive && setUrl(u))
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        io.disconnect()
        loadCover(rec.hash, size).then(
          u => {
            if (!alive) return
            if (u) {
              fresh.current = true
              setUrl(u)
            } else setMissing(true)
          },
          () => alive && setMissing(true),
        )
      },
      { rootMargin: '300px' },
    )
    io.observe(el)
    return () => {
      alive = false
      off()
      io.disconnect()
    }
  }, [rec.hash, rec.hasCover, rec.coverRev, url, size])
  const [bg, fg] = genColors(rec.hash)
  return (
    <div className={`cover ${selected ? 'selected' : ''}`} ref={ref}>
      {url ? (
        // 同步解码：缩略图很小，解码只要一两毫秒；异步解码会在重新显示时先空一帧（看起来就是闪）
        // 缩略图很小：同步解码，重新显示时不会先空一帧。
        // 单本模式的大图：已经在后台提前解码好，这里用异步，万一缓存被清掉也不会卡住滑动的那一帧
        <img src={url} alt="" decoding={large ? 'async' : 'sync'} draggable={false} className={fresh.current ? 'fresh' : undefined} />
      ) : rec.hasCover && !missing ? (
        // 有封面但还没读出来：先留一块底色，不拿“生成的封面”顶替（否则读出来时会换一下图，像闪了一下）
        <div className="cover-wait" />
      ) : (
        <div className="cover-gen" style={{ background: bg, color: fg }}>
          <b>{rec.title}</b>
          <small>{rec.author || rec.format.toUpperCase()}</small>
        </div>
      )}
      {!rec.hasFile && <span className="badge">{tr('云端')}</span>}
      {rec.hasFile && rec.localOnly && <span className="badge">{tr('本机')}</span>}
      {selecting && (
        <span className={`check ${selected ? 'on' : ''}`} aria-hidden>
          {selected && <IconCheck />}
        </span>
      )}
    </div>
  )
})
