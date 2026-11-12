import { defineConfig, type Plugin } from 'vite'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'

const host = process.env.TAURI_DEV_HOST

// https://v2.tauri.app/start/frontend/vite/
/** 开发用的示例书放在 public/dev-samples，发布构建时删掉，避免被打进安装包 */
const stripDevSamples = (): Plugin => ({
  name: 'readly-strip-dev-samples',
  apply: 'build',
  closeBundle() {
    rmSync(resolve(__dirname, 'dist/dev-samples'), { recursive: true, force: true })
  },
})

export default defineConfig({
  plugins: [react(), stripDevSamples()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'es2022',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})
