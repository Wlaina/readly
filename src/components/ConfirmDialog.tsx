import { useEffect, useRef, useState } from 'react'
import { closeDialog, useDialog } from '../lib/dialog'
import { tr } from '../lib/i18n'
import Presence from './Presence'

export default function ConfirmDialog() {
  const d = useDialog(s => s.current)
  // 复选框（askConfirmCheck）：每次弹出时恢复成初始值
  const [checked, setChecked] = useState(false)
  const checkedRef = useRef(false)
  checkedRef.current = checked
  useEffect(() => {
    setChecked(!!d?.check?.checked)
  }, [d])

  useEffect(() => {
    if (!d) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog(false)
      if (e.key === 'Enter') closeDialog(true, !!d.check && checkedRef.current)
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
        {d.check && (
          <div style={{ margin: '-6px 0 18px' }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 14, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={checked}
                onChange={e => setChecked(e.target.checked)}
                style={{ accentColor: 'var(--brand)', marginTop: 3, flex: 'none' }}
              />
              <span>{d.check.label}</span>
            </label>
            {d.check.hint && <div style={{ fontSize: 12, color: 'var(--text-2)', margin: '4px 0 0 24px' }}>{d.check.hint}</div>}
          </div>
        )}
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={() => closeDialog(false)}>
            {d.cancelText ?? tr('取消')}
          </button>
          <button className={`btn ${d.danger ? 'danger-fill' : 'primary'}`} autoFocus onClick={() => closeDialog(true, !!d.check && checked)}>
            {d.okText ?? tr('确定')}
          </button>
        </div>
      </div>
    </>
      )}
    </Presence>
  )
}
