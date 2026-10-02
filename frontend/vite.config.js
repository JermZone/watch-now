import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const version = process.env.NOW_BUILD_VERSION || JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_SOURCE__: JSON.stringify(process.env.NOW_SOURCE_URL || 'https://github.com/JermZone/watch-now'),
  },
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
  },
});
