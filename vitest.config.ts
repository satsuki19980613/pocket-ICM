import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      // Edge Function の共通ロジック（Deno 依存を持たない純 TS だけ）
      'supabase/functions/_shared/**/*.test.ts',
    ],
    environment: 'node',
    globals: false,
  },
});
