/**
 * DTF GangSheet Studio — 웹(SPA) 빌드 설정.
 *
 * 데스크톱(Electron) 렌더러 소스를 그대로 재사용하면서 Electron IPC(window.api)만
 * web/src/api/webApi.ts 브라우저 구현으로 교체한다. 루트 node_modules를 공유하며
 * `npm run web:dev` / `web:build` / `web:preview`로 구동한다.
 */
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const webRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: webRoot,
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@renderer': fileURLToPath(new URL('../src/renderer/src', import.meta.url)),
      '@core': fileURLToPath(new URL('../src/core', import.meta.url)),
      '@workers': fileURLToPath(new URL('../src/workers', import.meta.url)),
      '@shared': fileURLToPath(new URL('../src/types', import.meta.url))
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096
  },
  worker: {
    format: 'es' as const
  }
})
