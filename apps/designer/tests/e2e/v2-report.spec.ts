// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';

// E2E（专项步骤 4）：样例切换 v2 中国式报表模板不抛错，关键能力可见；
// v1 样例走 loadTemplate 自动迁移链并显示迁移提示。
test('盘点汇总表（v2）：多级表头/容器渲染且 pageerror 为空', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/');
  await page.getByTestId('open-designer').click();
  await page.getByTestId('sample-select').selectOption('inventory-report');
  await expect(page.getByTestId('version-chip')).toContainText('DSL 2.0');
  await expect(page.getByTestId('table-header-row').first()).toBeVisible();
  await expect(page.getByTestId('diagonal-label-tl').first()).toBeVisible();
  await expect(page.getByTestId('table-group-header')).toBeVisible();
  await expect(page.getByTestId('loop-chip')).toContainText('each=batches');
  await expect(page.getByTestId('conditional-chip')).toBeVisible();
  await expect(page.getByTestId('watermark-overlay')).toBeVisible();
  await expect(page.getByTestId('validation-status')).toContainText('校验通过');
  expect(errors).toEqual([]);
});

test('代金券联页（v2）：nup 副本与图片水印占位渲染', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/');
  await page.getByTestId('open-designer').click();
  await page.getByTestId('sample-select').selectOption('coupon-sheet');
  await expect(page.getByTestId('nup-chip')).toContainText('2×2');
  expect(await page.getByTestId('nup-copy').count()).toBe(3);
  await expect(page.getByTestId('watermark-placeholder')).toBeVisible();
  expect(errors).toEqual([]);
});

test('销售单（v1.0）：自动迁移至 2.0 并提示', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/');
  await page.getByTestId('open-designer').click();
  await page.getByTestId('sample-select').selectOption('sales-note');
  await expect(page.getByTestId('version-chip')).toContainText('DSL 2.0');
  await expect(page.getByTestId('load-note')).toContainText('已从 1.0 迁移至 2.0');
  expect(errors).toEqual([]);
});
