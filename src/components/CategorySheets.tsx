/**
 * 书架分类的两个面板：
 * - AssignSheet：给一本或多本书勾选分类（一本书可以属于多个分类）
 * - ManageSheet：新建、改名、排序、删除分类
 */
import { useState } from 'react'
import { liveCategories, useStore } from '../lib/store'
import { askConfirm } from '../lib/dialog'
import { tr } from '../lib/i18n'
import Sheet from './Sheet'
import { IconCheck, IconChevronDown, IconChevronUp, IconPlus, IconTrash } from './icons'

function NewCategory({ onAdd, autoFocus }: { onAdd: (id: string) => void; autoFocus?: boolean }) {
  const [name, setName] = useState('')
  const add = () => {
    const clean = name.trim()
    if (!clean) return
    const id = useStore.getState().addCategory(clean)
    setName('')
    if (id) onAdd(id)
  }
  return (
    <form
      className="cat-new"
      onSubmit={e => {
        e.preventDefault()
        add()
      }}
    >
      <input className="field" value={name} maxLength={40} placeholder={tr('新分类的名字')} autoFocus={autoFocus} enterKeyHint="done" onChange={e => setName(e.target.value)} />
      <button type="submit" className="btn primary" disabled={!name.trim()}>
        <IconPlus />
        {tr('新建')}
      </button>
    </form>
  )
}

/** 给这些书勾选分类；多本书时，只有部分书在某个分类里显示为“半选” */
export function AssignSheet({ hashes, onClose }: { hashes: string[]; onClose: () => void }) {
  const cats = liveCategories(useStore(s => s.categories))
  const library = useStore(s => s.library)
  const pick = new Set(hashes)
  const books = library.filter(b => pick.has(b.hash))
  const { setBooksCategory } = useStore.getState()
  return (
    <>
      <div className="scrim dim book-sheet-scrim" onClick={onClose} />
      <Sheet className="book-sheet cat-sheet" onClose={onClose} role="dialog" aria-label={tr('选择分类')}>
        <h3 className="serif">{books.length === 1 ? tr('《{title}》的分类', { title: books[0].title }) : tr('{n} 本书的分类', { n: books.length })}</h3>
        <div className="cat-list">
          {cats.map(c => {
            const n = books.filter(b => b.categories?.includes(c.id)).length
            const state = n === 0 ? 'off' : n === books.length ? 'on' : 'some'
            return (
              <button key={c.id} className={`cat-row ${state}`} role="checkbox" aria-checked={state === 'on' ? true : state === 'some' ? 'mixed' : false} onClick={() => setBooksCategory(hashes, c.id, state !== 'on')}>
                <span className="cat-check">{state === 'on' ? <IconCheck /> : state === 'some' ? <i /> : null}</span>
                <span className="cat-name">{c.name}</span>
              </button>
            )
          })}
          {!cats.length && <p className="cat-empty">{tr('还没有分类，先在下面建一个')}</p>}
        </div>
        <NewCategory onAdd={id => setBooksCategory(hashes, id, true)} />
        <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button className="btn primary" onClick={onClose}>
            {tr('完成')}
          </button>
        </div>
      </Sheet>
    </>
  )
}

/** 管理分类：改名（改完自动保存）、上下移动、删除、新建 */
export function ManageSheet({ onClose }: { onClose: () => void }) {
  const cats = liveCategories(useStore(s => s.categories))
  const library = useStore(s => s.library)
  const { renameCategory, removeCategory, moveCategory } = useStore.getState()
  const count = (id: string) => library.filter(b => !b.deletedAt && b.categories?.includes(id)).length
  return (
    <>
      <div className="scrim dim book-sheet-scrim" onClick={onClose} />
      <Sheet className="book-sheet cat-sheet" onClose={onClose} role="dialog" aria-label={tr('管理分类')}>
        <h3 className="serif">{tr('管理分类')}</h3>
        <div className="cat-list">
          {cats.map((c, i) => (
            <div key={c.id} className="cat-edit">
              <input
                className="field"
                defaultValue={c.name}
                maxLength={40}
                aria-label={tr('分类名')}
                onBlur={e => {
                  const v = e.target.value.trim()
                  if (v && v !== c.name) renameCategory(c.id, v)
                  else e.target.value = c.name
                }}
                onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
              <span className="cat-count">{count(c.id)}</span>
              <button className="icon-btn" aria-label={tr('上移')} disabled={i === 0} onClick={() => moveCategory(c.id, -1)}>
                <IconChevronUp />
              </button>
              <button className="icon-btn" aria-label={tr('下移')} disabled={i === cats.length - 1} onClick={() => moveCategory(c.id, 1)}>
                <IconChevronDown />
              </button>
              <button
                className="icon-btn danger"
                aria-label={tr('删除分类')}
                onClick={async () => {
                  if (await askConfirm({ title: tr('删除分类「{name}」？', { name: c.name }), message: tr('只删除这个分类，里面的书还在书架上。'), okText: tr('删除'), danger: true }))
                    removeCategory(c.id)
                }}
              >
                <IconTrash />
              </button>
            </div>
          ))}
          {!cats.length && <p className="cat-empty">{tr('还没有分类，先在下面建一个')}</p>}
        </div>
        <NewCategory onAdd={() => {}} />
        <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button className="btn primary" onClick={onClose}>
            {tr('完成')}
          </button>
        </div>
      </Sheet>
    </>
  )
}
