import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      // Edge Function の共通ロジック（Deno 依存を持たない純 TS だけ）
      'supabase/functions/_shared/**/*.test.ts',
      // SIT & GO Worker の純関数部分（DO 本体は型検査のみ。tsconfig.worker で別枠）
      'worker/**/*.test.ts',
    ],
    environment: 'node',
    globals: false,
    // 実テーブルを使うソルバーの同期テストは 1 本 5〜7 秒かかる。vitest 3 以降は同期テストにも
    // 既定 5 秒の上限を当てるので、ふつうの上限を広げておく（個別に長い上限を持つテストはそのまま）。
    testTimeout: 20_000,
  },
});
