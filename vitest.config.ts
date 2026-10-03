import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.{test,spec}.ts', 'test/**/*.{test,spec}.ts'],
    environment: 'node',
  },
});
