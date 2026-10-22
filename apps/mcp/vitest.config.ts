// SPDX-License-Identifier: Apache-2.0
// vitest 配置：开发期将 `taprint` / `taprint-preview` 别名指向包源码
// （packages/taprint-ts/src、packages/taprint-preview/src），无需先构建 dist。
// 发布依赖仍用 package.json 的 workspace 协议（pnpm）或 "*"（npm 工作区）。
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      taprint: fileURLToPath(new URL('../../packages/taprint-ts/src/index.ts', import.meta.url)),
      'taprint-preview': fileURLToPath(new URL('../../packages/taprint-preview/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
  },
});
