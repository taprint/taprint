// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';

// 版本管理 e2e：设计器改动保存 → 版本页发布 → 再改再发布 → 回滚 v1。
// 断言时间线 currentVersion 标记 / dslHash 短显 / 状态徽标 / pageerror 空。
//
// 依赖契约（DesignerPage 预载 + saveChannel）：/design/:id 从 Repository 预载草稿，
// workbench 顶栏 sample-select 载入样例（内存草稿）+ save-button 经 saveChannel 写回当前
// 路由模板的 Repository 草稿（样例下拉「载入样例后保存写当前路由模板」语义）。
// seed（template-domain）：id=1 销售单（预置 v1 published、草稿==v1）、id=2 盘点汇总表（draft）。
//
// ★ 导航纪律：内存 Repository 刷新即重置——本用例全程使用 SPA 内导航
// （App 头部「模板列表」+ 列表行链接），**禁止 page.goto 二次整页加载**（会重置 seed）。
test('版本全流程：发布禁用基线 → 改动 → 发布 v2/v3 → 指针式回滚 v1（pageerror 空）', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));

  //① 版本页初始态：seed id=1 草稿 == v1 已发布内容 → 发布禁用提示 + 时间线 v1 + 当前标记
  await page.goto('/versions/1');
  // 冷启动首屏在并行负载下可能超过 5s 默认超时——初始加载放宽到 15s（后续步骤页面已热）
  await expect(page.getByTestId('version-history-page')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('current-version-badge')).toContainText('当前版本：1');
  await expect(page.getByTestId('timeline-row')).toHaveCount(1);
  await expect(page.getByTestId('publish-no-changes-hint')).toBeVisible();
  await expect(page.getByTestId('publish-button')).toBeDisabled();

  //② 设计器改动并保存：sample-select 载入 coupon-sheet（内存草稿）→ save-button 写回模板 1
  // SPA 导航：头部「模板列表」→ 列表行「设计」链接（避免整页刷新重置内存 Repository）
  await page.getByRole('link', { name: '模板列表' }).click();
  await expect(page.getByTestId('template-list-table')).toBeVisible();
  await page.getByTestId('template-design-1').click();
  await expect(page.getByTestId('sample-select')).toBeVisible();
  await page.getByTestId('sample-select').selectOption('coupon-sheet');
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('designer-last-saved')).toBeVisible({ timeout: 5_000 });

  //③ 发布 v2：有未发布改动 → 填备注 → 发布 → 时间线 v1/v2、当前=v2
  await page.getByRole('link', { name: '模板列表' }).click();
  await page.getByTestId('template-versions-1').click();
  await expect(page.getByTestId('has-unpublished-chip')).toBeVisible();
  await page.getByTestId('publish-note-input').fill('coupon 副本改动');
  await page.getByTestId('publish-button').click();
  await expect(page.getByTestId('timeline-row')).toHaveCount(2);
  await expect(page.getByTestId('current-version-badge')).toContainText('当前版本：2');
  await expect(page.getByTestId('timeline-row').first().getByTestId('timeline-version')).toHaveText(
    'v2',
  );
  await expect(
    page.getByTestId('timeline-row').first().getByTestId('timeline-current-marker'),
  ).toBeVisible();
  await expect(page.getByTestId('timeline-row').first().getByTestId('timeline-hash')).toContainText(
    'hash ',
  );

  //④ 再改再发布 v3：载入 inventory-report → 保存 → 发布
  await page.getByRole('link', { name: '模板列表' }).click();
  await page.getByTestId('template-design-1').click();
  await page.getByTestId('sample-select').selectOption('inventory-report');
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('designer-last-saved')).toBeVisible({ timeout: 5_000 });
  await page.getByRole('link', { name: '模板列表' }).click();
  await page.getByTestId('template-versions-1').click();
  await expect(page.getByTestId('has-unpublished-chip')).toBeVisible();
  await page.getByTestId('publish-note-input').fill('inventory 副本改动');
  await page.getByTestId('publish-button').click();
  await expect(page.getByTestId('timeline-row')).toHaveCount(3);
  await expect(page.getByTestId('current-version-badge')).toContainText('当前版本：3');

  //⑤ 指针式回滚 v1：current 移到 v1、时间线条目数不变（3 条）、草稿同步 → 无未发布改动
  const rows = page.getByTestId('timeline-row');
  const rowV1 = rows.nth(2); // 倒序：v3, v2, v1
  await expect(rowV1.getByTestId('timeline-version')).toHaveText('v1');
  await rowV1.getByTestId('rollback-button').click();
  await expect(page.getByTestId('rollback-confirm-section')).toContainText('v1');
  await page.getByTestId('rollback-confirm-button').click();
  await expect(page.getByTestId('current-version-badge')).toContainText('当前版本：1');
  await expect(page.getByTestId('timeline-row')).toHaveCount(3); // 指针式：不产生新版本行
  await expect(
    page.getByTestId('timeline-row').nth(2).getByTestId('timeline-current-marker'),
  ).toBeVisible();
  await expect(page.getByTestId('has-unpublished-chip')).toHaveCount(0);

  //⑥ pageerror 全程为空
  expect(errors).toEqual([]);
});
