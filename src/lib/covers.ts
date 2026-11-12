/**
 * 封面图：书架上用缩小后的图（解码快、占内存少，上百本书也不会让系统回收后整页重画），
 * 单本模式用大一点的图。同一本书同一种尺寸只生成一次；封面更新时作废。
 */
import { paths, readBytes, removeFile, writeBytes } from './storage'

export type CoverSize = 'thumb' | 'large'
/** 缩略图最长的宽度（像素）：原图不比它大多少时直接用原图 */
const MAX_W: Record<CoverSize, number> = { thumb: 360, large: 960 }

const urls = new Map<string, string>()
const loading = new Map<string, Promise<string | null>>()
const colorCache = new Map<string, string>()
const key = (hash: string, size: CoverSize) => `${hash}|${size}`

/** 等某张封面准备好的人：别处（例如轮播的预加载）把它读出来时，立刻通知到正在显示占位的封面组件 */
const waiters = new Map<string, Set<(url: string) => void>>()
export function onCoverReady(hash: string, size: CoverSize, cb: (url: string) => void): () => void {
  const k = key(hash, size)
  let set = waiters.get(k)
  if (!set) waiters.set(k, (set = new Set()))
  set.add(cb)
  return () => {
    set!.delete(cb)
    if (!set!.size && waiters.get(k) === set) waiters.delete(k)
  }
}

/** 已经准备好的封面地址（没有就返回 undefined，不触发读取） */
export const peekCover = (hash: string, size: CoverSize = 'thumb') => urls.get(key(hash, size))

/** 正在删除某本书磁盘上的缩略图：重新读取前要等它删完，否则会读到旧图 */
const clearing = new Map<string, Promise<unknown>>()

export function invalidateCover(hash: string) {
  for (const size of ['thumb', 'large'] as CoverSize[]) {
    const k = key(hash, size)
    const url = urls.get(k)
    if (url) URL.revokeObjectURL(url)
    urls.delete(k)
    loading.delete(k)
  }
  colorCache.delete(hash)
  backdropCache.delete(hash)
  const job = Promise.all((['thumb', 'large'] as CoverSize[]).map(size => removeFile(paths.coverCache(hash, size)).catch(() => {}))).finally(() => {
    if (clearing.get(hash) === job) clearing.delete(hash)
  })
  clearing.set(hash, job)
}

/* 同时最多处理 3 张：快速滚动书架时不会一下子解码几十张原图 */
let active = 0
const waiting: (() => void)[] = []
async function limit<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 3) await new Promise<void>(r => waiting.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}

async function shrink(blob: Blob, maxW: number): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return blob
  const bmp = await createImageBitmap(blob)
  try {
    if (bmp.width <= maxW * 1.2) return blob
    const w = maxW
    const h = Math.max(1, Math.round((bmp.height * w) / bmp.width))
    if (typeof OffscreenCanvas === 'function') {
      const c = new OffscreenCanvas(w, h)
      const ctx = c.getContext('2d')
      if (!ctx) return blob
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bmp, 0, 0, w, h)
      return await c.convertToBlob({ type: 'image/webp', quality: 0.86 })
    }
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    if (!ctx) return blob
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, w, h)
    return await new Promise<Blob>(res => c.toBlob(b => res(b ?? blob), 'image/webp', 0.86))
  } finally {
    bmp.close()
  }
}

/** 读取并准备一张封面；没有封面文件时返回 null */
export function loadCover(hash: string, size: CoverSize = 'thumb'): Promise<string | null> {
  const k = key(hash, size)
  const ready = urls.get(k)
  if (ready) return Promise.resolve(ready)
  let p = loading.get(k)
  if (!p) {
    p = limit(async () => {
      await clearing.get(hash)
      // 先看磁盘上有没有上次缩好的图：有就直接用，不用再读原图、解码、缩小（开书架、滑到远处的书都快得多）
      const cachePath = paths.coverCache(hash, size)
      const cached = await readBytes(cachePath).catch(() => null)
      let out: Blob
      if (cached?.byteLength) out = new Blob([cached as BlobPart], { type: 'image/webp' })
      else {
        const bytes = await readBytes(paths.cover(hash))
        if (!bytes) return null
        const src = new Blob([bytes as BlobPart])
        out = src
        try {
          out = await shrink(src, MAX_W[size])
        } catch {
          /* 缩小失败（图片格式特殊等）：直接用原图 */
        }
        // 确实缩小了才存盘（原图本来就小的，下次直接读原图）
        if (out !== src && loading.get(k) === p) {
          const small = out
          small
            .arrayBuffer()
            .then(b => writeBytes(cachePath, new Uint8Array(b)))
            .catch(() => {})
        }
      }
      // 读取途中封面被更新（作废）了：这次的结果不要
      if (loading.get(k) !== p) return null
      const url = URL.createObjectURL(out)
      // 大图先在后台解码好再交出去：单本模式滑到这本时直接拿解码好的图，不在滑动的那一帧里现场解码（会掉帧）
      if (size === 'large') {
        try {
          const img = new Image()
          img.src = url
          await img.decode()
        } catch {
          /* 解码失败也照常交出去，由显示时再解码 */
        }
        if (loading.get(k) !== p) {
          URL.revokeObjectURL(url)
          return null
        }
      }
      urls.set(k, url)
      for (const cb of [...(waiters.get(k) ?? [])]) cb(url)
      return url
    }).finally(() => {
      if (loading.get(k) === p) loading.delete(k)
    })
    loading.set(k, p)
  }
  return p
}

const backdropCache = new Map<string, string>()

/**
 * 单本模式的背景图：把封面缩成很小的一张（约 36×54），再用 CSS 放大铺满——缩小本身就是最便宜的模糊，
 * 不用在整屏上跑实时模糊滤镜。没有封面的书用生成封面的颜色做一张渐变。
 */
export async function coverBackdrop(hash: string, hasCover: boolean): Promise<string | null> {
  const hit = backdropCache.get(hash)
  if (hit) return hit
  const c = document.createElement('canvas')
  // 在画布里一次性模糊好（96×144 放大到整屏仍然柔和），页面上不再跑实时模糊滤镜
  c.width = 96
  c.height = 144
  const ctx = c.getContext('2d')
  if (!ctx) return null
  const url = hasCover ? (peekCover(hash, 'thumb') ?? peekCover(hash, 'large') ?? (await loadCover(hash, 'thumb').catch(() => null))) : null
  let drawn = false
  if (url) {
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      ctx.filter = 'blur(7px) saturate(1.35)'
      ctx.drawImage(img, -14, -14, 124, 172)
      drawn = true
    } catch {
      /* 画不出来就用生成封面的颜色 */
    }
  }
  if (!drawn) {
    const [a, b] = genColors(hash)
    const g = ctx.createLinearGradient(0, 0, 96, 144)
    g.addColorStop(0, a)
    g.addColorStop(1, b)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 96, 144)
  }
  const out = c.toDataURL('image/jpeg', 0.85)
  if (backdropCache.size > 200) backdropCache.clear()
  backdropCache.set(hash, out)
  return out
}

/** 生成封面（没有图片的书）用的配色，和书架上看到的一致 */
export const GEN_PALETTE = [
  ['#d97757', '#fff6ec'],
  ['#7d8b6a', '#f4f6ee'],
  ['#c49a5a', '#fffaf0'],
  ['#8c6b5d', '#faf3ee'],
  ['#5e5d59', '#f5f4ed'],
]
export const genColors = (hash: string) => GEN_PALETTE[parseInt(hash.slice(0, 2), 16) % GEN_PALETTE.length]

/**
 * 封面主色：把封面缩到 12×18 像素求平均，再略微提亮提纯，用作单本模式背后的氛围光。
 * 每本书只算一次。
 */
export async function coverColor(hash: string, hasCover = true): Promise<string> {
  const hit = colorCache.get(hash)
  if (hit) return hit
  const url = peekCover(hash, 'thumb') ?? peekCover(hash, 'large') ?? (hasCover ? await loadCover(hash, 'thumb').catch(() => null) : null)
  let color = genColors(hash)[0]
  if (url) {
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      const c = document.createElement('canvas')
      c.width = 12
      c.height = 18
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0, 12, 18)
      const d = ctx.getImageData(0, 0, 12, 18).data
      let r = 0
      let g = 0
      let b = 0
      let w = 0
      for (let i = 0; i < d.length; i += 4) {
        // 越鲜艳的像素权重越大，避免被大片白底/黑底稀释
        const max = Math.max(d[i], d[i + 1], d[i + 2])
        const min = Math.min(d[i], d[i + 1], d[i + 2])
        const weight = 0.25 + (max - min) / 255
        r += d[i] * weight
        g += d[i + 1] * weight
        b += d[i + 2] * weight
        w += weight
      }
      const hex = (v: number) => Math.round(Math.min(255, v)).toString(16).padStart(2, '0')
      color = `#${hex(r / w)}${hex(g / w)}${hex(b / w)}`
    } catch {
      /* 读不到就用生成封面的颜色 */
    }
  }
  colorCache.set(hash, color)
  return color
}
