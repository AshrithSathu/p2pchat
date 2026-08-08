import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

process.env['TURN_KEY_ID'] ??= 'test-turn-key-id';
process.env['TURN_KEY_API_TOKEN'] ??= 'test-turn-api-token';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TURN_PROVIDER: 'cloudflare',
          COTURN_SHARED_SECRET: '',
          COTURN_URLS: '',
          TURN_KEY_ID: 'test-turn-key-id',
          TURN_KEY_API_TOKEN: 'test-turn-api-token',
        },
      },
    }),
  ],
});
