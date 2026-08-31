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
        // Basic Pitchのモデルファイル(.json/.bin)もオフラインキャッシュ対象に含める
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,bin}'],
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
