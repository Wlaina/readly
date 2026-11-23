/**
 * 自绘确认弹窗：安卓 WebView 不支持 window.confirm，统一用这个。
 * 用法：if (await askConfirm({ title: '删除', message: '…', danger: true })) …
 * 需要附带一个复选框时用 askConfirmCheck，返回 { ok, checked }。
 */
import { create } from 'zustand'

export interface ConfirmOptions {
  title: string
  message?: string
  okText?: string
  cancelText?: string
  danger?: boolean
}

export interface ConfirmCheck {
  /** 复选框文字 */
  label: string
  /** 初始是否勾选 */
  checked?: boolean
  /** 复选框下方的小字说明 */
  hint?: string
}

interface DialogState {
  current: (ConfirmOptions & { check?: ConfirmCheck; resolve: (ok: boolean, checked: boolean) => void }) | null
}

export const useDialog = create<DialogState>(() => ({ current: null }))

export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  return askConfirmCheck(opts).then(r => r.ok)
}

/** 带一个复选框的确认弹窗；取消时 checked 也一并返回，但调用方通常只在 ok 时使用 */
export function askConfirmCheck(opts: ConfirmOptions & { check?: ConfirmCheck }): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise(resolve => {
    // 同时只显示一个：旧的视为取消
    useDialog.getState().current?.resolve(false, false)
    useDialog.setState({ current: { ...opts, resolve: (ok, checked) => resolve({ ok, checked }) } })
  })
}

export function closeDialog(ok: boolean, checked = false) {
  const cur = useDialog.getState().current
  useDialog.setState({ current: null })
  cur?.resolve(ok, checked)
}
