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

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless'
}

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
  // onnxruntime-web은 자체 wasm을 import.meta.url 기준으로 찾으므로 사전 번들에서 제외
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  // crossOriginIsolated — WASM 멀티스레드(WebGPU 미지원 브라우저의 AI 배경 제거 속도)용
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: {
    format: 'es' as const
  }
})
