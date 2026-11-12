import { useStore } from '../lib/store'
import { foldersSupported } from '../lib/folders'
import { formatTime } from '../lib/hooks'
import { askConfirm } from '../lib/dialog'
import { Card, Row } from './ui'
import { IconPlus, IconSync, IconTrash } from './icons'
import { tr } from '../lib/i18n'
import { isEn } from '../lib/i18n'

/** 书籍文件夹：放进文件夹的书自动加入书架（仅本机，不随设置同步） */
export default function FoldersCard() {
  const folders = useStore(s => s.folders)
  const scanning = useStore(s => s.folderScanning)
  const { addFolder, removeFolder, scanFolders } = useStore.getState()
  if (!foldersSupported) return null

  return (
    <Card title={tr('书籍文件夹')}>
      <div className="note" style={{ marginTop: 12 }}>
        {tr('选择一个文件夹后，里面的 EPUB / TXT 会全部加入书架；以后往文件夹里放新书，Readly 会自动发现并导入（启动时、切回应用时、每 2 分钟检查一次），开启云同步时也会上传到云端。')}
      </div>
      {folders.map(f => (
        <Row
          key={f.id}
          label={<span className="folder-name">📁 {f.name}</span>}
          hint={
            f.error
              ? `⚠ ${f.error}`
              : `${f.path ?? tr('已授权的手机文件夹')} · ${tr('{n} 本', { n: f.count ?? 0 })}${f.failed?.length ? tr('（{n} 本无法导入：{list}）', { n: f.failed.length, list: f.failed.slice(0, 3).join(isEn() ? ', ' : '、') + (f.failed.length > 3 ? '…' : '') }) : ''} · ${tr('检查于 {time}', { time: formatTime(f.lastScan) })}`
          }
        >
          <button
            className="icon-btn"
            aria-label={tr('停止同步 {name}', { name: f.name })}
            title={tr('停止同步（已导入的书会保留）')}
            onClick={async () =>
              (await askConfirm({ title: tr('停止同步「{name}」？', { name: f.name }), message: tr('已经导入的书会保留在书架上。'), okText: tr('停止同步'), danger: true })) &&
              removeFolder(f.id)
            }
          >
            <IconTrash />
          </button>
        </Row>
      ))}
      <div className="btn-row" style={{ padding: '12px 0 14px' }}>
        <button className="btn primary" onClick={() => addFolder()}>
          <IconPlus />
          {tr('添加文件夹')}
        </button>
        {folders.length > 0 && (
          <button className="btn" disabled={scanning} onClick={() => scanFolders(true)}>
            <IconSync style={scanning ? { animation: 'pulse .6s infinite alternate' } : undefined} />
            {scanning ? tr('检查中…') : tr('立即检查')}
          </button>
        )}
      </div>
    </Card>
  )
}
