// SPDX-License-Identifier: Apache-2.0
// vitest 配置：开发期将 `taprint` 别名指向内核源码（packages/taprint-ts/src），
// 无需先构建内核 dist（apps/mcp vitest.config.ts 同模式）。
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      taprint: fileURLToPath(new URL('../taprint-ts/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 30000,
  },
});
