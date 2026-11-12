import { readJSON, writeJSON } from './storage'

export type DeviceClass = 'desktop' | 'mobile'

/** 手机与电脑分开同步外观设置 */
export const deviceClass: DeviceClass = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'mobile' : 'desktop'
export const isAndroid = /Android/i.test(navigator.userAgent)

export interface DeviceInfo {
  id: string
  name: string
}

let device: DeviceInfo = { id: 'unknown', name: '' }
export const getDevice = () => device

export async function initDevice() {
  const saved = await readJSON<DeviceInfo | null>('device.json', null)
  if (saved?.id) return (device = saved)
  device = {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
    name: deviceClass === 'mobile' ? '手机' : '电脑',
  }
  await writeJSON('device.json', device)
  return device
}

/** 本地日期键 YYYY-MM-DD */
export function dayKey(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
