// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from '@playwright/test';

// 等 monaco 真正初始化完成（host 容器在加载期也可见，须等 .monaco-editor 出现）
async function expectEditorReady(page: Page): Promise<void> {
  await expect(page.getByTestId('expr-loading')).toHaveCount(0);
  await expect(page.locator('[data-testid="expr-host"] .monaco-editor')).toBeVisible();
}

// 点编辑区（.view-lines）取焦：monaco 隐藏 textarea 不满足 click 可操作性检查
function monacoViewLines(page: Page) {
  return page.locator('[data-testid="expr-host"] .view-lines');
}

// E2E（表达式编辑器）：DR14 运行期侧——monaco 异步 chunk + worker 启动
// 无 pageerror；fx 入口打开编辑器、编译错误就近展示、编辑回写 DSL（prop-content
// 普通 textarea 与 monaco 双视图同步）。构建期侧（chunk 拆分/worker 产物）由
// vite build 产物清单验证（monaco chunk 独立、editor.worker 资产生成）。

test('text 内容 fx 编辑器：monaco 启动 + 编译错误就近 + 回写往返', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/');
  await page.getByTestId('open-designer').click();
  await page.getByTestId('sample-select').selectOption('sales-note');
  await page.getByTestId('device-receipt').click();
  await page.getByTestId('layer-item-0').click();
  await expect(page.getByTestId('prop-content')).toBeVisible();

  await page.getByTestId('prop-content-fx').click();
  await expect(page.getByTestId('expr-host')).toBeVisible();
  await expectEditorReady(page);
  await expect(page.getByTestId('expr-fallback')).toHaveCount(0);

  await monacoViewLines(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('小票 {{1 +}} 尾');
  await expect(page.getByTestId('expr-errors')).toContainText('表达式意外结束', {
    timeout: 5_000,
  });
  // 回写往返：monaco → store → 普通 textarea 同步
  await expect(page.getByTestId('prop-content')).toHaveValue('小票 {{1 +}} 尾');

  // 修正为合法表达式后错误列表消失
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('小票 {{orderNo}} 尾');
  await expect(page.getByTestId('expr-errors')).toHaveCount(0, { timeout: 5_000 });
  expect(errors).toEqual([]);
});

test('conditional when fx 编辑器：入口可用且回写 container-when', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/');
  await page.getByTestId('open-designer').click();
  await page.getByTestId('sample-select').selectOption('inventory-report');
  await page
    .getByTestId('layers-panel')
    .getByText(/条件：when=/)
    .click();
  await expect(page.getByTestId('container-when')).toBeVisible();

  await page.getByTestId('container-when-fx').click();
  await expect(page.getByTestId('expr-host')).toBeVisible();
  await expectEditorReady(page);
  await monacoViewLines(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('{{a @ b}}');
  await expect(page.getByTestId('expr-errors')).toContainText('非法字符', { timeout: 5_000 });
  await expect(page.getByTestId('container-when')).toHaveValue('{{a @ b}}');
  expect(errors).toEqual([]);
});
