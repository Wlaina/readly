import { useStore } from '../lib/store'
import { foldersSupported, type FolderDeleteMode } from '../lib/folders'
import { formatTime } from '../lib/hooks'
import { askConfirm } from '../lib/dialog'
import { Card, Row, Segmented, Toggle } from './ui'
import { isWindowsApp } from '../lib/native'
import { Fragment } from 'react'
import { IconPlus, IconSync, IconTrash } from './icons'
import { tr } from '../lib/i18n'
import { isEn } from '../lib/i18n'

/** 书籍文件夹：放进文件夹的书自动加入书架（仅本机，不随设置同步） */
export default function FoldersCard() {
  const folders = useStore(s => s.folders)
  const scanning = useStore(s => s.folderScanning)
  const { addFolder, removeFolder, scanFolders, setFolderCollect, setFolderDeleteMode, reimportFolder } = useStore.getState()
  if (!foldersSupported) return null

  return (
    <Card title={tr('书籍文件夹')}>
      <div className="note" style={{ marginTop: 12 }}>
        {tr('选择一个文件夹后，里面的 EPUB / TXT 会全部加入书架；以后往文件夹里放新书，Readly 会自动发现并导入（启动时、切回应用时、每 2 分钟检查一次），开启云同步时也会上传到云端。')}
      </div>
      {folders.map(f => (
        <Fragment key={f.id}>
        <Row
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
        {isWindowsApp && f.path && (
          <Row
            label={tr('其他设备的书也存到这里')}
            hint={tr('手机上传、从云端同步下来的书会自动复制一份到这个文件夹（启动时与每次同步后），OneDrive 等会继续同步出去；从文件夹里删掉的书不会再放回来。只能有一个文件夹开启。')}
          >
            <Toggle on={!!f.collect} onChange={v => setFolderCollect(f.id, v)} />
          </Row>
        )}
        {isWindowsApp && f.path && (
          <Row
            label={tr('移除书时删除文件夹里的文件')}
            hint={tr('在书架上移除来自这个文件夹的书时，是否也删除文件夹里的原文件（直接删除，不进回收站）。')}
          >
            <Segmented<FolderDeleteMode>
              value={f.deleteFiles ?? 'ask'}
              options={[
                ['ask', tr('每次询问')],
                ['always', tr('总是一起删除')],
                ['never', tr('只删书架上的')],
              ]}
              onChange={v => setFolderDeleteMode(f.id, v)}
            />
          </Row>
        )}
        <Row
          label={tr('重新导入不在书架上的书')}
          hint={tr('之前在书架上移除、但文件还留在文件夹里的书不会自动回来；点这里把它们重新加入书架（原来的进度、书签、笔记会一起恢复）。')}
        >
          <button className="btn" disabled={scanning} onClick={() => reimportFolder(f.id)}>
            {tr('重新导入')}
          </button>
        </Row>
        </Fragment>
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
