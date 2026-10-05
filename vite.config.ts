import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, createLogger } from 'vite';

const customLogger = createLogger();
const originalError = customLogger.error.bind(customLogger);
customLogger.error = (msg, options) => {
  if (
    msg.includes('ws error') ||
    msg.includes('1006') ||
    msg.includes('Invalid WebSocket frame') ||
    (options?.error && String(options.error).includes('1006'))
  ) {
    return;
  }
  originalError(msg, options);
};

export default defineConfig(() => {
  return {
    customLogger,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio to prevent WebSocket 1006 iframe disconnect noise
      hmr: false,
      watch: null,
    },
    build: {
      chunkSizeWarningLimit: 1500,
    },
  };
});
