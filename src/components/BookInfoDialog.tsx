import { useEffect, useState } from 'react'
import { useStore } from '../lib/store'
import type { BookRecord } from '../lib/types'
import { formatTime } from '../lib/hooks'
import { BookCover } from './BookCover'
import { tr } from '../lib/i18n'

const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** 编辑书籍信息：书名、作者。EPUB 会写进文件本身，并写回书籍文件夹、同步到云端 */
export default function BookInfoDialog({ rec, onClose }: { rec: BookRecord; onClose: () => void }) {
  const [title, setTitle] = useState(rec.title)
  const [author, setAuthor] = useState(rec.author)
  const [saving, setSaving] = useState(false)
  const folders = useStore(s => s.folders)
  const folder = rec.folderRef && folders.find(f => f.id === rec.folderRef!.folderId)
  const changed = title.trim() !== rec.title || author.trim() !== rec.author

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async () => {
    if (!changed || !title.trim()) return onClose()
    setSaving(true)
    await useStore.getState().editBook(rec.hash, { title, author })
    setSaving(false)
    onClose()
  }

  const source = folder
    ? tr('书籍文件夹「{name}」/ {rel}', { name: folder.name, rel: rec.folderRef!.rel })
    : rec.remotePath
      ? tr('云端 {path}', { path: rec.remotePath })
      : rec.localOnly
        ? tr('仅本机')
        : tr('本机导入')

  return (
    <>
      <div className="scrim dim fade-in" style={{ zIndex: 120 }} onClick={onClose} />
      <div className="dialog book-info glass" role="dialog" aria-modal="true" aria-label={tr('编辑书籍信息')}>
        <div className="book-info-head">
          <div className="book-info-cover">
            <BookCover rec={rec} />
          </div>
          <div className="book-info-fields">
            <label className="field-label">{tr('书名')}</label>
            <input className="field" value={title} onChange={e => setTitle(e.target.value)} autoFocus />
            <label className="field-label">{tr('作者')}</label>
            <input className="field" value={author} placeholder={tr('多位作者用顿号分隔')} onChange={e => setAuthor(e.target.value)} />
          </div>
        </div>
        <dl className="book-info-meta">
          <dt>{tr('格式')}</dt>
          <dd>
            {rec.format.toUpperCase()} · {fmtSize(rec.size)}
          </dd>
          <dt>{tr('来源')}</dt>
          <dd>{source}</dd>
          <dt>{tr('加入书架')}</dt>
          <dd>{new Date(rec.addedAt).toLocaleDateString()}</dd>
          {rec.fileRev && (
            <>
              <dt>{tr('文件更新')}</dt>
              <dd>{formatTime(rec.fileRev)}</dd>
            </>
          )}
        </dl>
        <p className="book-info-note">
          {rec.format === 'epub'
            ? folder?.path
              ? tr('保存后会同时修改书籍文件，并写回书籍文件夹里的原文件（OneDrive 等会继续同步），再上传到 WebDAV。')
              : tr('保存后会同时修改书籍文件，并同步到其他设备。')
            : tr('TXT 没有内嵌书籍信息，只修改书架上的显示，并同步到其他设备。')}
        </p>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            {tr('取消')}
          </button>
          <button className="btn primary" disabled={saving || !title.trim()} onClick={save}>
            {saving ? tr('保存中…') : tr('保存')}
          </button>
        </div>
      </div>
    </>
  )
}
