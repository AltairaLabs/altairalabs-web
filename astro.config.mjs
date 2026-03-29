// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import indexnow from 'astro-indexnow';

// https://astro.build/config
export default defineConfig({
  site: 'https://www.altairalabs.ai',
  integrations: [
    sitemap(),
    indexnow({ key: 'b0b43bb38390400e9e428615ad93ff35' }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
