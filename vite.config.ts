import { defineConfig } from 'vite';
import { lanDev } from './server/vite-plugin.ts';

export default defineConfig({
  plugins: [lanDev()],
  server: { host: true, port: 5173 },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        play: 'index.html',
        controller: 'controller.html',
      },
    },
  },
});
