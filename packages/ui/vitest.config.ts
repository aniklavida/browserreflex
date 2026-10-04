import { defineConfig } from 'vitest/config';

// Tests run in jsdom. The React plugin is not needed: the test transform reads the JSX
// setting from tsconfig.json.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
