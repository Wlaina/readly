/**
 * 传输任务中心：同步、上传、下载、导入、扫描的状态与进度，供“同步 → 传输任务”页面展示。
 */
import { create } from 'zustand'

export type TaskKind = 'sync' | 'pull' | 'push' | 'upload' | 'download' | 'import' | 'scan'

export interface Task {
  id: string
  kind: TaskKind
  title: string
  detail?: string
  status: 'running' | 'done' | 'error'
  /** 已完成量与总量（字节或个数）；没有总量时显示不确定进度 */
  loaded?: number
  total?: number
  unit?: 'bytes' | 'items'
  error?: string
  startedAt: number
  endedAt?: number
}

interface TaskState {
  tasks: Task[]
}

export const useTasks = create<TaskState>(() => ({ tasks: [] }))

const KEEP = 80
let seq = 0

export function startTask(kind: TaskKind, title: string, extra: Partial<Task> = {}): string {
  const id = `${Date.now().toString(36)}-${seq++}`
  const task: Task = { id, kind, title, status: 'running', startedAt: Date.now(), ...extra }
  useTasks.setState(s => ({ tasks: [task, ...s.tasks].slice(0, KEEP) }))
  return id
}

/** 更新进度；高频调用时按帧合并，避免下载大文件时频繁重渲染 */
const pending = new Map<string, Partial<Task>>()
let raf = 0
export function updateTask(id: string, patch: Partial<Task>) {
  pending.set(id, { ...pending.get(id), ...patch })
  if (raf) return
  const flush = () => {
    raf = 0
    const p = new Map(pending)
    pending.clear()
    useTasks.setState(s => ({ tasks: s.tasks.map(t => (p.has(t.id) ? { ...t, ...p.get(t.id) } : t)) }))
  }
  raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(flush) : (setTimeout(flush, 16) as unknown as number)
}

export function endTask(id: string, error?: unknown) {
  // 先合并还没刷新的进度更新（例如最后一条“成功 N 本”说明）
  const last = pending.get(id)
  pending.delete(id)
  useTasks.setState(s => ({
    tasks: s.tasks.map(t =>
      t.id === id
        ? {
            ...t,
            ...last,
            status: error ? 'error' : 'done',
            error: error ? (error instanceof Error ? error.message : String(error)) : undefined,
            loaded: error ? t.loaded : t.total ?? t.loaded,
            endedAt: Date.now(),
          }
        : t,
    ),
  }))
}

/** 包装一个异步操作为任务 */
export async function runTask<T>(kind: TaskKind, title: string, fn: (id: string) => Promise<T>, extra: Partial<Task> = {}): Promise<T> {
  const id = startTask(kind, title, extra)
  try {
    const r = await fn(id)
    endTask(id)
    return r
  } catch (e) {
    endTask(id, e)
    throw e
  }
}

export function clearFinished() {
  useTasks.setState(s => ({ tasks: s.tasks.filter(t => t.status === 'running') }))
}

export const KIND_LABEL: Record<TaskKind, string> = {
  sync: '同步',
  pull: '拉取进度',
  push: '上传记录',
  upload: '上传',
  download: '下载',
  import: '导入',
  scan: '扫描',
}
