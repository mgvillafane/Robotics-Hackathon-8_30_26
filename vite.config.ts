import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    // drei pulls in stats-gl, which pins an older three. Without deduping,
    // two copies load and three.js warns that its shared state is split,
    // which breaks instanceof checks across libraries.
    dedupe: ['three'],
  },
  server: {
    port: 5173,
  },
});
