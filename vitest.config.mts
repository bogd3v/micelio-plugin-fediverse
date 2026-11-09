import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // The suites boot a real Strapi on SQLite, one database file per worker (test/strapi.ts).
    pool: 'threads',
    // Booting Strapi takes a few seconds, more on a cold CI runner.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
})
