import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Local previews of the production build read the shop's books and faucet from the live API.
  preview: { proxy: { '/api': { target: 'https://takeback-bch.vercel.app', changeOrigin: true } } },
})
