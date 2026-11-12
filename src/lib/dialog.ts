/**
 * 自绘确认弹窗：安卓 WebView 不支持 window.confirm，统一用这个。
 * 用法：if (await askConfirm({ title: '删除', message: '…', danger: true })) …
 */
import { create } from 'zustand'

export interface ConfirmOptions {
  title: string
  message?: string
  okText?: string
  cancelText?: string
  danger?: boolean
}

interface DialogState {
  current: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
}

export const useDialog = create<DialogState>(() => ({ current: null }))

export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    // 同时只显示一个：旧的视为取消
    useDialog.getState().current?.resolve(false)
    useDialog.setState({ current: { ...opts, resolve } })
  })
}

export function closeDialog(ok: boolean) {
  const cur = useDialog.getState().current
  useDialog.setState({ current: null })
  cur?.resolve(ok)
}
