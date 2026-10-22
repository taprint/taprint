// SPDX-License-Identifier: Apache-2.0
// E2E（Playwright）：用例随里程碑补齐
//
// webServer 由 Playwright 自动拉起 vite dev（baseURL 仅是请求基准，不会启动 server）。
//
// 端口环境变量化：DESIGNER_E2E_PORT 覆盖 dev server / baseURL 端口（默认 3200），
// 供端口被常驻服务占用的环境下独立自启，无需生成临时 config。
const e2ePort = Number(process.env.DESIGNER_E2E_PORT) || 3200;
const e2eUrl = `http://localhost:${e2ePort}`;

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: e2eUrl,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --port ${e2ePort} --strictPort`,
    url: e2eUrl,
    reuseExistingServer: !process.env.CI,
  },
});
