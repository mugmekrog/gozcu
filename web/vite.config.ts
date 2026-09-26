import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173, strictPort: false },
  build: {
    // The demo runs from a venue laptop, possibly with the network off
    // (PLAN F4.3), so nothing may be fetched from a CDN at runtime. Everything
    // ships in the bundle or in public/.
    target: 'es2022',
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        // Keep the radar's geometry out of the entry chunk: the Hareket and
        // Kayitlar views are route-level splits, so the first paint only pays
        // for the map.
        manualChunks: { react: ['react', 'react-dom'] },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
