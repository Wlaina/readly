import { tr } from '../lib/i18n'
import { installUpdate, useUpdate } from '../lib/updater'
import { IconX } from './icons'
import Presence from './Presence'

/** 书架等页面底部的更新提示：发现新版本时出现，可以直接更新，也可以关掉 */
export default function UpdateBanner() {
  const up = useUpdate()
  const show = !up.dismissed && ['available', 'downloading', 'installing'].includes(up.status)
  const busy = up.status !== 'available'
  return (
    <Presence show={show}>
    <div className="update-banner glass" role="status">
      <div className="update-text">
        <b>{tr('Readly {v} 可以更新了', { v: up.version })}</b>
        {busy ? (
          <div className="progress-line">
            <i style={{ width: `${up.progress * 100}%` }} />
          </div>
        ) : (
          up.notes && <span>{up.notes.split('\n')[0]}</span>
        )}
      </div>
      {!busy && (
        <>
          <button className="btn primary" onClick={installUpdate}>
            {tr('立即更新')}
          </button>
          <button className="icon-btn" aria-label={tr('稍后')} onClick={() => useUpdate.setState({ dismissed: true })}>
            <IconX />
          </button>
        </>
      )}
    </div>
    </Presence>
  )
}
