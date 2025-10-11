import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
const API_PROXY_TARGET = process.env.VITE_API_BASE_URL ?? 'http://localhost:5000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_PROXY_TARGET,
        changeOrigin: true,
      },
      '/static': {
        target: API_PROXY_TARGET,
        changeOrigin: true,
      },
    },
  },
})
