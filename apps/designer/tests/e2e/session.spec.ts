// SPDX-License-Identifier: Apache-2.0
// session HTTP 层 + full 模式 ensureSession e2e（设计契约口径）：
// 宿主模拟场景 = full 模式带 URL 一次性 code（降级口径：默认 mock transport 内存
// TTL 仿真，真实后端接线挂账）。调试钩子 __sessionMockTtl/__sessionCheckInterval
// 缩短 TTL 与监控周期使过期/续期场景在 e2e 时间窗内可达（生产 URL 不带即 no-op）。
import { expect, test } from '@playwright/test';

test('① full 带 code：兑换成功挂载应用 + URL 清除 code（token 绝不进 URL）', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/?code=e2e-once-code');
  // full 应用挂载（模板列表首页）
  await expect(page.getByTestId('open-designer')).toBeVisible({ timeout: 15_000 });
  // code 经 history.replaceState 从 URL 清除（防残留/分享泄露）
  expect(new URL(page.url()).searchParams.get('code')).toBeNull();
  // 无过期弹窗（mock TTL 600s，监控周期 60s，e2e 窗口内健康）
  await expect(page.getByTestId('session-expired')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('② full 无 code：降级期 no-op 不阻断（既有 full 场景零回归）', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/');
  await expect(page.getByTestId('open-designer')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('session-expired')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('③ token 过期：周期 check 检出 401 → 过期弹窗 + 引导回源（表格 full 行）', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  // 缩短 mock TTL 至 1.5s + 监控周期 500ms；adminOrigin 注入同源（e2e 内闭环跳转）
  await page.goto(
    '/?code=e2e-expire-code&__sessionMockTtl=1500&__sessionCheckInterval=500' +
      '&adminOrigin=http://localhost:3200',
  );
  await expect(page.getByTestId('open-designer')).toBeVisible({ timeout: 15_000 });
  // 约 1.5s 后 check 检出过期：弹窗「会话过期」
  await expect(page.getByTestId('session-expired')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('session-expired')).toContainText('会话已过期');
  expect(errors).toEqual([]);
});

test('④ 剩余 TTL ≤10% 主动 refresh：会话续期不中断（监控 + session-api 全链）', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  // TTL 2s + 周期 300ms：约 1.8s 时剩余 ≤10%（200ms）触发直连 refresh，TTL 重置
  await page.goto('/?code=e2e-refresh-code&__sessionMockTtl=2000&__sessionCheckInterval=300');
  await expect(page.getByTestId('open-designer')).toBeVisible({ timeout: 15_000 });
  // 越过首次 refresh 窗口（≥2.5s）后会话仍健康：无过期弹窗，应用可交互
  await page.waitForTimeout(2_600);
  await expect(page.getByTestId('session-expired')).toHaveCount(0);
  await expect(page.getByTestId('open-designer')).toBeVisible();
  expect(errors).toEqual([]);
});
