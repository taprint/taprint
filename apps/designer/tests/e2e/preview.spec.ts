// SPDX-License-Identifier: Apache-2.0
// E2E（M2 预览仿真）：DSL 直渲近似预览的运行期侧——异步 chunk 加载 + canvas 光栅化
// 无 pageerror；doc 设备类 UNSUPPORTED_DEVICE_CLASS 提示；embed 本地预览
// 过渡能力（宿主 preview 通道为后续扩展）。布局纯层由单测覆盖。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/templates/sales-note-v1.0.json',
);
const salesNoteV1 = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;

test('① full + receipt：预览覆盖层 → PNG 仿真图可见，pageerror 空', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/');
  await page.getByTestId('open-designer').click();
  await page.getByTestId('sample-select').selectOption('sales-note');
  await page.getByTestId('device-receipt').click();

  await page.getByTestId('preview-button').click();
  await expect(page.getByTestId('preview-overlay')).toBeVisible();
  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('preview-error')).toHaveCount(0);

  // 关闭覆盖层
  await page.getByTestId('preview-close').click();
  await expect(page.getByTestId('preview-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('② doc 设备类：UNSUPPORTED_DEVICE_CLASS 提示（口径）', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/');
  await page.getByTestId('open-designer').click();
  await page.getByTestId('sample-select').selectOption('inventory-report');

  await page.getByTestId('preview-button').click();
  await expect(page.getByTestId('preview-unsupported')).toBeVisible({ timeout: 15_000 });
  // S1 文案口径：明示非 bug 宿主预览通道预期 + 画布替代
  await expect(page.getByTestId('preview-unsupported')).toContainText('宿主');
  await expect(page.getByTestId('preview-unsupported')).toContainText('画布排版');
  await expect(page.getByTestId('preview-image')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('③ embed（web-iframe 宿主通道）：预览按钮可用（宿主 前过渡能力）', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.addInitScript((template) => {
    (window as unknown as { __TEST_TEMPLATE__: unknown }).__TEST_TEMPLATE__ = template;
  }, salesNoteV1);
  await page.goto('/test-host.html');

  const frame = page.frameLocator('[data-testid="designer-frame"]');
  await expect(frame.getByTestId('designer-canvas')).toBeVisible({ timeout: 15_000 });
  await frame.getByTestId('device-receipt').click();
  await frame.getByTestId('preview-button').click();
  await expect(frame.getByTestId('preview-overlay')).toBeVisible();
  await expect(frame.getByTestId('preview-image')).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});
