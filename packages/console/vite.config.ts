import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Served by the bus at /console/ (packages/core/src/ws/http.ts).
export default defineConfig({
  plugins: [react()],
  base: '/console/',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5180,
    proxy: {
      '/api': 'http://127.0.0.1:7777',
      '/console-ws': { target: 'ws://127.0.0.1:7777', ws: true, rewrite: () => '/console' },
    },
  },
})
