/**
 * 敏感信息（WebDAV 密码）的本机加密存放：
 * - Windows：DPAPI，只有当前 Windows 账户在这台电脑上能解开
 * - 安卓：系统 Keystore，密钥存在手机的安全硬件里、不可导出
 * 加密只发生在写盘时，内存里仍是明文，使用体验不变。
 * 旧版本留下的明文密码照常读取，下一次保存时自动加密。
 */
import { isTauri } from './storage'
import { androidBridge, isWindowsApp } from './native'

const PREFIX = 'enc1:'
let cache: { plain: string; cipher: string } | null = null

export async function protect(plain: string): Promise<string> {
  if (!plain || !isTauri) return plain
  if (cache?.plain === plain) return cache.cipher
  let c = ''
  try {
    if (isWindowsApp) {
      const { invoke } = await import('@tauri-apps/api/core')
      c = await invoke<string>('protect_secret', { text: plain })
    } else c = androidBridge()?.protectSecret?.(plain) ?? ''
  } catch (e) {
    console.warn('加密密码失败，按原样保存', e)
  }
  if (!c) return plain // 系统不支持时退回原来的方式，不影响使用
  const cipher = PREFIX + c
  cache = { plain, cipher }
  return cipher
}

/** 解不开（换了 Windows 账户、重装了应用）时返回空串：同步页会提示重新输入密码 */
export async function unprotect(stored: string): Promise<string> {
  if (!stored?.startsWith(PREFIX)) return stored ?? ''
  const body = stored.slice(PREFIX.length)
  try {
    let plain: string | undefined
    if (isWindowsApp) {
      const { invoke } = await import('@tauri-apps/api/core')
      plain = await invoke<string>('unprotect_secret', { hex: body })
    } else {
      const r = androidBridge()?.unprotectSecret?.(body)
      plain = r === '\u0000' ? undefined : r
    }
    if (plain == null) return ''
    cache = { plain, cipher: stored }
    return plain
  } catch (e) {
    console.warn('解密密码失败', e)
    return ''
  }
}

export const isProtected = (stored?: string) => !!stored?.startsWith(PREFIX)
