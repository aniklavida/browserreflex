import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.{test,spec}.ts', 'test/**/*.{test,spec}.ts'],
    // The UI has its own config (jsdom) and runs through `pnpm --filter=@browserreflex/ui run test`.
    exclude: ['packages/ui/**', '**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
});
