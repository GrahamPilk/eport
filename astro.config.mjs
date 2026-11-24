// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { SITE } from './src/site.config.mjs';

export default defineConfig({
  site: SITE.url,
  trailingSlash: 'ignore',
  integrations: [sitemap()],
  build: { inlineStylesheets: 'always' }, // one less request on first paint (NFC taps = cold mobile loads)
  markdown: { shikiConfig: { theme: 'min-light' } },
});
