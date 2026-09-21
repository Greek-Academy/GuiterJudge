import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Basic Pitch のモデル(.json/.bin)、生徒モデル(.onnx)、ONNX Runtime の WASM もオフラインキャッシュ対象に含める。
        // WASM は 14 MB あるので workbox の既定上限(2 MiB)を上げる
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,bin,onnx,wasm,mjs}'],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
      },
      manifest: {
        name: 'ギター上達診断アプリ',
        short_name: '上達診断',
        start_url: '.',
        display: 'standalone',
        background_color: '#f9f9f7',
        theme_color: '#2a78d6',
        icons: [],
      },
    }),
  ],
})
