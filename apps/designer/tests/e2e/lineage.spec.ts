// SPDX-License-Identifier: Apache-2.0
import { expect, test } from '@playwright/test';

// 模板血缘（lineage）E2E。
//
// 覆盖流程：
//① 另存为完整链路：列表点「另存为」→ 对话框 → 确认 → 新模板血缘标记可见。
//② 血缘页祖先/后代渲染（seed 预置 sales-note id=1 → coupon-sheet id=3 副本）。
//③ 删除守卫：删除有后代的基线模板（sales-note）应被 Repository 守卫拒绝并 UI 提示。
// 全程 pageerror 空（兼容性基线）。
//
// seed 预置（seed.ts）：
// - id=1 sales-note（receipt）sourceTemplateId=null，currentVersion=1
// - id=2 inventory-report（doc）sourceTemplateId=null，currentVersion=null
// - id=3 coupon-sheet（receipt）sourceTemplateId=1，sourceVersion=1（sales-note 副本）

test.describe('模板血缘（lineage）', () => {
  test('另存为对话框交互正确 + done 触发跳转设计器', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));

    // 列表入口
    await page.goto('/');
    await expect(page.getByTestId('template-list-table')).toBeVisible();

    // 对 sales-note（id=1）做另存为（列表按模板 API 契约 插槽用法挂 SaveAsDialog）
    const trigger = page.getByTestId('save-as-trigger-1');
    await trigger.click();
    await expect(page.getByTestId('save-as-modal')).toBeVisible();

    // 来源说明区：sourceTemplateId 字段语义提示（血缘标记的核心验证点）
    await expect(page.getByTestId('save-as-source-info')).toBeVisible();
    await expect(page.getByTestId('save-as-source-version')).toContainText('源版本 v1');

    // 取消按钮触发关闭（cancel 事件契约）
    await page.getByTestId('save-as-cancel').click();
    await expect(page.getByTestId('save-as-modal')).toHaveCount(0);

    // 再次打开 + 输入新名称 + 确认
    await page.getByTestId('save-as-trigger-1').click();
    const nameInput = page.getByTestId('save-as-name-input');
    await nameInput.fill('销售小票-测试副本');
    await page.getByTestId('save-as-confirm').click();

    // done 事件触发列表页 onDuplicated → 跳 /design/{newId}（newId ≥ 4，seed 用了 1/2/3）
    await page.waitForURL(/\/design\/(\d+)/, { timeout: 5000 });
    const newId = Number(new URL(page.url()).pathname.split('/').pop());
    expect(newId).toBeGreaterThanOrEqual(4);

    // 注：mock 内存 Repository 是模块级单例 + 刷新即重置，
    // 回列表页 page.goto 会触发刷新重置，无法验证血缘 chip 持久态；
    // 血缘字段（sourceTemplateId/sourceVersion）正确性由 Repository 单测锚定
    // （template-domain.spec.ts duplicate 用例），本 e2e 只验证对话框契约。

    // pageerror 空（兼容性基线）
    expect(errors).toEqual([]);
  });

  test('血缘页祖先/后代渲染正确（seed 预置 sales-note→coupon-sheet）', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));

    // coupon-sheet (id=3) 是 sales-note (id=1) 的副本，祖先应为 sales-note
    await page.goto('/lineage/3');
    await expect(page.getByTestId('lineage-focus-name')).toHaveText(/代金券/);

    // 焦点模板卡片显示源模板来源
    await expect(page.getByTestId('lineage-focus-source')).toContainText('模板 #1');
    await expect(page.getByTestId('lineage-focus-source')).toContainText('v1');

    // 祖先链渲染：1 级（sales-note）
    await expect(page.getByTestId('lineage-ancestors')).toBeVisible();
    await expect(page.getByTestId('lineage-ancestor-0')).toContainText(/销售单/);

    // 后代树：coupon-sheet 自己没后代（seed 无更深链）
    await expect(page.getByTestId('lineage-descendants')).toHaveCount(0);

    // 血缘 vs 门店覆盖链概念声明可见
    await expect(page.getByTestId('lineage-concept-note')).toContainText('门店覆盖链');

    // 继承不联动声明可见
    await expect(page.getByTestId('lineage-inheritance-note')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('血缘页：sales-note 有后代 coupon-sheet（反向视角）', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/lineage/1');
    await expect(page.getByTestId('lineage-focus-name')).toContainText(/销售单/);

    // sales-note 无祖先（顶层模板），祖先链 section 不渲染
    await expect(page.getByTestId('lineage-ancestors')).toHaveCount(0);

    // 后代树含 coupon-sheet (id=3)
    await expect(page.getByTestId('lineage-descendants')).toBeVisible();
    await expect(page.getByTestId('lineage-descendant-0')).toContainText(/代金券/);

    expect(errors).toEqual([]);
  });

  test('删除守卫：有后代的基线模板（sales-note）被拒', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/');
    await expect(page.getByTestId('template-list-table')).toBeVisible();

    // 删除 sales-note（id=1）—— Repository 守卫应抛 TemplateHasDescendantsError
    await page.getByTestId('template-delete-1').click();
    await page.getByTestId('delete-confirm-1').click();

    // 列表应显示错误（列表实现 catch + UI 提示）
    await expect(page.getByTestId('template-list-error')).toBeVisible();
    await expect(page.getByTestId('template-list-error')).toContainText(/后代|存在|禁止/);

    // sales-note 仍在列表中（未被删除）
    await expect(page.getByTestId('template-row-1')).toBeVisible();

    expect(errors).toEqual([]);
  });
});
