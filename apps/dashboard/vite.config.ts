/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev the gateway runs on :8080; its CSRF guard compares Origin with PUBLIC_ORIGIN, so start it
// with PUBLIC_ORIGIN=http://localhost:5173.
const gateway = 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': gateway,
      '/mcp': gateway,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});
