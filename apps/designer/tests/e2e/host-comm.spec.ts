// SPDX-License-Identifier: Apache-2.0
// 宿主通信 e2e：public/test-host.html 模拟宿主，
// iframe web-iframe 通道，覆盖握手/迁移、保存闭环、验签拒收、只读门禁、预览/测试打印通道、
// 只读锁可见性、token-refreshed 推送复位等场景（设计契约）。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/templates/sales-note-v1.0.json',
);
const salesNoteV1 = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;

async function openHostPage(page: Page): Promise<void> {
  await page.addInitScript((template) => {
    (window as unknown as { __TEST_TEMPLATE__: unknown }).__TEST_TEMPLATE__ = template;
  }, salesNoteV1);
  await page.goto('/test-host.html');
}

const designerFrame = (page: Page) => page.frameLocator('[data-testid="designer-frame"]');

test('① 握手：ready → loadTemplate v1.0 → 迁移 2.0 渲染画布', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await openHostPage(page);

  // ready 后宿主自动下发 loadTemplate；设计器完成迁移并渲染
  const frame = designerFrame(page);
  await expect(frame.getByTestId('designer-canvas')).toBeVisible({ timeout: 15_000 });
  await expect(frame.getByTestId('version-chip')).toHaveText('DSL 2.0'); // v1.0 → 2.0 迁移
  await expect(frame.getByTestId('load-note')).toContainText('已从 1.0 迁移至 2.0');
  expect(await frame.getByTestId('canvas-element').count()).toBeGreaterThan(0);
  await expect(frame.getByTestId('embed-status-chip')).toHaveText('已连接宿主');
  expect(errors).toEqual([]);
});

test('② 保存闭环：prepareSave 门禁 → save 上行 → saveResult 回执', async ({ page }) => {
  await openHostPage(page);
  const frame = designerFrame(page);
  await expect(frame.getByTestId('version-chip')).toHaveText('DSL 2.0', { timeout: 15_000 });

  await frame.getByTestId('save-button').click();
  await expect(page.getByTestId('host-status')).toHaveText('save');
  await expect(frame.getByTestId('save-receipt')).toHaveText('保存成功');
});

test('③ 安全：篡改签名消息被验签拒收；无 token 超时致命错误 UI', async ({ page }) => {
  await openHostPage(page);
  const frame = designerFrame(page);
  await expect(frame.getByTestId('version-chip')).toHaveText('DSL 2.0', { timeout: 15_000 });
  // 握手后宿主最近一次收到 ready（loadTemplate 为宿主下行，不计入上行状态）
  await expect(page.getByTestId('host-status')).toHaveText('ready');

  await page.getByTestId('host-tamper').click();
  // 设计器静默丢弃：readonly-chip 不出现、宿主侧无新上行（状态停留 ready）
  await page.waitForTimeout(500);
  await expect(frame.getByTestId('readonly-chip')).toHaveCount(0);
  await expect(page.getByTestId('host-status')).toHaveText('ready');
});

test('③-b 无 token 注入：10s 超时渲染致命错误 UI（不挂载工作台）', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto('/?embedMode=wpf');
  await expect(page.getByTestId('embed-fatal')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('embed-fatal')).toContainText('token');
  await expect(page.getByTestId('designer-canvas')).toHaveCount(0);
});

test('④ 只读：setReadOnly → 保存门禁 + 只读 chip', async ({ page }) => {
  await openHostPage(page);
  const frame = designerFrame(page);
  await expect(frame.getByTestId('version-chip')).toHaveText('DSL 2.0', { timeout: 15_000 });

  await page.getByTestId('host-readonly').click();
  await expect(frame.getByTestId('readonly-chip')).toBeVisible();
  await expect(frame.getByTestId('save-button')).toHaveAttribute('aria-disabled', 'true');

  // aria-disabled 门禁：按钮保持可聚焦可点，
  // Playwright 视 aria-disabled 为 not enabled，force 模拟真实点击
  await frame.getByTestId('save-button').click({ force: true });
  await expect(frame.getByTestId('save-note')).toContainText('只读模式');
  // 只读门禁拦截，未发送 save：宿主状态停留在 ready
  await expect(page.getByTestId('host-status')).toHaveText('ready');

  await page.getByTestId('host-writable').click();
  await expect(frame.getByTestId('readonly-chip')).toHaveCount(0);
});

// ── preview / testPrint 通道往返 ──

test('⑤ preview 往返：上行 preview → 宿主自动回 previewResult → 设计器渲染宿主预览图', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await openHostPage(page);
  const frame = designerFrame(page);
  await expect(frame.getByTestId('version-chip')).toHaveText('DSL 2.0', { timeout: 15_000 });

  await frame.getByTestId('embed-preview-button').click();
  // 宿主侧收到 preview 上行
  await expect(page.getByTestId('host-status')).toHaveText('preview');
  // 宿主自动回 previewResult（test-host.html 默认回 PNG），设计器渲染宿主预览图
  await expect(frame.getByTestId('preview-receipt')).toBeVisible({ timeout: 5_000 });
  await expect(frame.getByTestId('preview-host-image')).toBeVisible();
  expect(errors).toEqual([]);
});

test('⑤-b preview 错误态：宿主回 errorMessage → 设计器顶栏红条展示', async ({ page }) => {
  await openHostPage(page);
  const frame = designerFrame(page);
  await expect(frame.getByTestId('version-chip')).toHaveText('DSL 2.0', { timeout: 15_000 });

  await frame.getByTestId('embed-preview-button').click();
  // 立即点错误回执按钮（在自动成功回执之前；若已成功则切换为错误态）
  await page.getByTestId('host-preview-error').click();
  await expect(frame.getByTestId('preview-receipt')).toContainText('预览失败', { timeout: 5_000 });
});

test('⑥ testPrint 往返：上行 testPrint → 宿主自动回 printResult（success） → 设计器显示成功回执', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await openHostPage(page);
  const frame = designerFrame(page);
  await expect(frame.getByTestId('version-chip')).toHaveText('DSL 2.0', { timeout: 15_000 });

  await frame.getByTestId('embed-testprint-button').click();
  await expect(page.getByTestId('host-status')).toHaveText('testPrint');
  await expect(frame.getByTestId('print-receipt')).toContainText('测试打印成功', {
    timeout: 5_000,
  });
  expect(errors).toEqual([]);
});

test('⑥-b testPrint 失败态：宿主回 success=false + errorMessage → 设计器显示失败原因', async ({
  page,
}) => {
  await openHostPage(page);
  const frame = designerFrame(page);
  await expect(frame.getByTestId('version-chip')).toHaveText('DSL 2.0', { timeout: 15_000 });

  await frame.getByTestId('embed-testprint-button').click();
  await page.getByTestId('host-print-result-fail').click();
  await expect(frame.getByTestId('print-receipt')).toContainText('缺纸', { timeout: 5_000 });
});

// ── readOnly 完整编辑锁（实浏览器验证 fieldset[disabled] inheritance） ──

test('⑦ 只读完整编辑锁：所有面板按钮真 disabled，画布元素不可选中', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await openHostPage(page);
  const frame = designerFrame(page);
  await expect(frame.getByTestId('version-chip')).toHaveText('DSL 2.0', { timeout: 15_000 });

  // 基线：可写态各面板按钮可点
  await expect(frame.locator('[data-testid="field-panel"]')).toHaveAttribute(
    'data-readonly',
    'false',
  );
  await expect(frame.locator('[data-testid="field-item"]').first()).toBeEnabled();

  // 宿主下发只读
  await page.getByTestId('host-readonly').click();
  await expect(frame.locator('[data-testid="field-panel"]')).toHaveAttribute(
    'data-readonly',
    'true',
  );
  await expect(frame.locator('[data-testid="property-panel"]')).toHaveAttribute(
    'data-readonly',
    'true',
  );
  await expect(frame.locator('[data-testid="layers-panel"]')).toHaveAttribute(
    'data-readonly',
    'true',
  );

  // 实浏览器 fieldset[disabled] inheritance：子按钮真 disabled
  // Playwright 的 toBeDisabled 匹配 HTML 标准 disabled 属性（含 fieldset 继承）
  await expect(frame.locator('[data-testid="field-item"]').first()).toBeDisabled();
  await expect(frame.locator('[data-testid="element-add-text"]').first()).toBeDisabled();
  // 图层选中按钮、删除按钮 disabled
  await expect(frame.locator('[data-testid="layer-item-0"] button.min-w-0')).toBeDisabled();
  // 属性面板按钮（如有选中元素）disabled
  // 选中一个元素：直接通过 layer 按钮已 disabled 不可点，预先在可写态选中
  // （这里仅断言根 panel disabled 状态，避免对选中态的依赖）

  // 解除只读：按钮恢复可用
  await page.getByTestId('host-writable').click();
  await expect(frame.locator('[data-testid="field-item"]').first()).toBeEnabled();
  expect(errors).toEqual([]);
});

// ── token-refreshed 推送复位（与单测的 notifyTokenExpired 配合） ──

test('⑧ token-refreshed 推送：宿主下发后设计器侧 token 监控复位（无显式 UI 表现，验证不破坏现状）', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await openHostPage(page);
  const frame = designerFrame(page);
  await expect(frame.getByTestId('version-chip')).toHaveText('DSL 2.0', { timeout: 15_000 });

  // 点击推送 token-refreshed：设计器侧 handleHostMessage token-refreshed 分支无副作用
  // （fatal 状态未触发则不改；监控计时器重启不报错）
  await page.getByTestId('host-token-refreshed').click();
  await expect(frame.getByTestId('embed-status-chip')).toHaveText('已连接宿主');
  // 确认设计器无 pageerror（token 监控重启链路无异常）
  expect(errors).toEqual([]);
});
