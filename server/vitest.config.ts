import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30000,
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://medone:medone@localhost:5432/medone_test' },
  },
});
