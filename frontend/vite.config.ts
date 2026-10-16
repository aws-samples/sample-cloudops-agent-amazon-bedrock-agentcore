import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: process.env.VITE_LOCAL_API === '1' ? {
      '/local-api': {
        target: 'http://127.0.0.1:8080',
        rewrite: requestPath => requestPath.replace(/^\/local-api/, ''),
      },
    } : undefined,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
