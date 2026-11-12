import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { hashBytes } from '../lib/book'
import { readOpenedFile } from '../lib/native'
import { enterReader } from '../lib/hooks'
import { tr } from '../lib/i18n'

/**
 * 处理“用 Readly 打开”的文件：
 * 已在书架上的直接打开；新书按设置（或询问）决定是否上传云端。
 */
export default function OpenFileDialog({ paths, onDone }: { paths: string[]; onDone: () => void }) {
  const [files, setFiles] = useState<File[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [remember, setRemember] = useState(false)
  const started = useRef(false)
  const syncReady = useStore(s => s.sync.enabled && !!s.sync.url && !!s.sync.username && !!s.sync.password)

  const finish = async (fresh: File[], localOnly: boolean, known: string[]) => {
    const st = useStore.getState()
    const added = fresh.length ? await st.importFiles(fresh, { localOnly, silent: true }) : []
    const first = known[0] ?? added[0]?.hash
    onDone()
    if (first) enterReader(first)
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    ;(async () => {
      const st = useStore.getState()
      const loaded: File[] = []
      const known: string[] = []
      for (const p of paths) {
        try {
          const f = await readOpenedFile(p)
          const hash = await hashBytes(new Uint8Array(await f.arrayBuffer()))
          const exist = st.library.find(b => b.hash === hash && !b.deletedAt && b.hasFile)
          if (exist) known.push(hash)
          else loaded.push(f)
        } catch (e) {
          st.showToast(tr('无法打开：{p}', { p }))
        }
      }
      const mode = st.settings.openFile
      if (!loaded.length || !syncReady || mode !== 'ask') {
        await finish(loaded, !syncReady || mode === 'local', known)
      } else {
        setFiles(loaded)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!files) return null

  const choose = async (localOnly: boolean) => {
    setBusy(true)
    if (remember) useStore.getState().updateSettings(s => ({ ...s, openFile: localOnly ? 'local' : 'upload' }))
    await finish(files, localOnly, [])
  }

  return (
    <>
      <div className="scrim dim" style={{ zIndex: 90 }} />
      <div
        className="glass open-file-dialog"
        style={{
          position: 'fixed',
          zIndex: 91,
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(420px, calc(100vw - 32px))',
          borderRadius: 24,
          padding: '22px 20px 18px',
        }}
      >
        <h2 style={{ fontSize: 20, margin: '0 0 6px' }}>{tr('用 Readly 打开')}</h2>
        <p style={{ margin: '0 0 14px', color: 'var(--text-2)', wordBreak: 'break-all' }}>
          {tr('{name} 是新书，要上传到云端吗？上传后其他设备也能读到它和阅读进度。', {
            name: files.length === 1 ? `《${files[0].name.replace(/\.[^.]+$/, '')}》` : tr('{n} 本书', { n: files.length }),
          })}
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-2)', marginBottom: 16 }}>
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} style={{ accentColor: 'var(--brand)' }} />
          {tr('记住我的选择（可在设置里修改）')}
        </label>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" disabled={busy} onClick={() => choose(true)}>
            {tr('仅本机阅读')}
          </button>
          <button className="btn primary" disabled={busy} onClick={() => choose(false)}>
            {tr('加入书架并上传')}
          </button>
        </div>
      </div>
    </>
  )
}
