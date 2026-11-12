import { useEffect } from 'react'
import { closeDialog, useDialog } from '../lib/dialog'
import { tr } from '../lib/i18n'
import Presence from './Presence'

export default function ConfirmDialog() {
  const d = useDialog(s => s.current)

  useEffect(() => {
    if (!d) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog(false)
      if (e.key === 'Enter') closeDialog(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [d])

  return (
    <Presence show={!!d}>
      {d && (
    <>
      <div className="scrim dim fade-in" style={{ zIndex: 120 }} onClick={() => closeDialog(false)} />
      <div className="dialog glass" role="alertdialog" aria-modal="true" aria-label={d.title}>
        <h2>{d.title}</h2>
        {d.message && <p>{d.message}</p>}
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={() => closeDialog(false)}>
            {d.cancelText ?? tr('取消')}
          </button>
          <button className={`btn ${d.danger ? 'danger-fill' : 'primary'}`} autoFocus onClick={() => closeDialog(true)}>
            {d.okText ?? tr('确定')}
          </button>
        </div>
      </div>
    </>
      )}
    </Presence>
  )
}
