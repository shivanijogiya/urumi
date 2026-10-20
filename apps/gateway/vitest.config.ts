import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Starts a throwaway postgres:16-alpine container (or uses TEST_DATABASE_URL) for the DB tests.
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
