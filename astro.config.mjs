import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

export default defineConfig({
  site: 'https://todo.adarshambati.com',
  output: 'server',
  adapter: vercel(),
  server: { port: 4322 },
  security: {
    // Astro's built-in check rejects any non-GET without a matching Origin,
    // which non-browser clients (iOS Shortcuts, curl) never send. The
    // equivalent check lives in src/middleware.ts, applied only to
    // cookie-authenticated requests where it's actually load-bearing.
    checkOrigin: false,
  },
});
