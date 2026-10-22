// SPDX-License-Identifier: Apache-2.0
/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite'; // Tailwind v4 官方 Vite 插件（设计契约）

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    // PWA 暂未启用（启用前先补 SBOM/Workbox 审计）；
    // WebView 宿主本地化走离线资源包，不走 Service Worker。
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 3200,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.spec.ts'],
  },
  build: {
    rollupOptions: {
      output: {
        // 表达式编辑器独立异步 chunk（实测 980KB gzipped / 约 3.85MB 原始， 构建口径，
        // 不计入核心预算）。
        // ：用函数式规则替代静态 { monaco: ['monaco-editor'] }——静态写法会把
        // monaco-editor 强行拉进模块图（无 import 仍产出 129KB CSS）；函数式仅在
        // 图中真实出现 monaco 模块（ExpressionEditor 实装）时独立成 chunk。
        manualChunks(id) {
          if (id.includes('node_modules/monaco-editor/')) return 'monaco';
          return undefined;
        },
      },
    },
  },
});
