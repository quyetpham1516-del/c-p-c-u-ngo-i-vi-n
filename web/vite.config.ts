import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // Ứng dụng kíp mở được khi mất mạng: lưu sẵn vỏ ứng dụng, dữ liệu ePCR nằm trong IndexedDB
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Medone – Cấp cứu ngoại viện',
        short_name: 'Medone',
        lang: 'vi',
        theme_color: '#0b4ea2',
        background_color: '#0f1720',
        display: 'standalone',
        icons: [{ src: '/logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
