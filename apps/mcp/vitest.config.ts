// SPDX-License-Identifier: Apache-2.0
// vitest 配置：开发期将 `taprint` 别名指向内核源码（packages/taprint-ts/src），
// 无需先构建内核 dist。发布依赖仍用 package.json 的 `workspace:*` 协议
// （pnpm 工作区解析；npm 不识别该协议，取舍见 README「安装与开发」）。
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      taprint: fileURLToPath(new URL('../../packages/taprint-ts/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
  },
});
