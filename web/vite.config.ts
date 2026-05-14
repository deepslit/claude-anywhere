import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// In dev we run Vite on 5173 and proxy /api/* to the FastAPI backend on 21580.
// In prod the FastAPI server itself serves the built SPA.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:21580',
        changeOrigin: true,
      },
    },
  },
})
