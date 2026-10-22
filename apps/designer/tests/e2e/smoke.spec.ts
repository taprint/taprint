// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';

// E2E 冒烟。
// embed 启动走 init 序列——先注入 token，样例经 ?fallbackSample=1 兜底。
test('embed 模式挂载不抛错且画布渲染', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.addInitScript(() => {
    (window as unknown as { __TAPRINT_TOKEN__: string }).__TAPRINT_TOKEN__ =
      'designer-session-token-fixture';
  });
  await page.goto('/?embedMode=wpf&fallbackSample=1');
  await expect(page.getByTestId('designer-canvas')).toBeVisible();
  await expect(page.getByTestId('layers-panel')).toBeVisible();
  expect(errors).toEqual([]);
});

test('full 模式首页可进入设计器', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-designer').click();
  await expect(page.getByTestId('designer-canvas')).toBeVisible();
});
