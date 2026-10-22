// SPDX-License-Identifier: Apache-2.0
// 专项步骤 4（块 A）：模板加载主入口——detectVersion → 迁移到 CURRENT_VERSION → 校验。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDesignerStore, type TemplateLike } from '../../src/canvas/store';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const readFixture = (rel: string): TemplateLike =>
  JSON.parse(readFileSync(resolve(repoRoot, rel), 'utf8')) as TemplateLike;

describe('store.loadTemplate（迁移 + 校验门禁）', () => {
  let store: ReturnType<typeof useDesignerStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useDesignerStore();
  });

  it('v1.0 模板自动迁移到 2.0 且结构不变（v2 为 v1 严格超集）', () => {
    const raw = readFixture('fixtures/templates/sales-note-v1.0.json');
    store.loadTemplate(raw);
    expect(store.schemaVersion).toBe('2.0');
    expect(store.loadNote).toContain('已从 1.0 迁移至 2.0');
    expect(store.dsl?.schemaVersion).toBe('2.0');
    expect(store.dsl?.code).toBe('SALES_NOTE');
    // 超集：除版本声明外结构与原模板一致
    const { schemaVersion: _a, ...migrated } = store.dsl as Record<string, unknown>;
    const { schemaVersion: _b, ...original } = raw as Record<string, unknown>;
    expect(migrated).toEqual(original);
    expect(store.validationValid).toBe(true);
  });

  it('label 文档禁升版：v1.0 文档原版本挂载、golden hash 不被写坏', () => {
    const raw = readFixture('fixtures/templates/shelf-label-v1.0.json');
    const before = JSON.stringify(raw);
    store.loadTemplate(raw);
    // 禁升版：schemaVersion 保持 1.0、无迁移提示、文档逐字不变（hash 锚定）
    expect(store.schemaVersion).toBe('1.0');
    expect(store.loadNote).toBeNull();
    expect(JSON.stringify(store.dsl)).toBe(before);
    expect(store.validationValid).toBe(true);
  });

  it('v1.1 label 文档同样禁升版原版本挂载', () => {
    const raw = readFixture('fixtures/templates/goods-label-v1.1.json');
    store.loadTemplate(raw);
    expect(store.schemaVersion).toBe('1.1');
    expect(store.loadNote).toBeNull();
    expect(store.validationValid).toBe(true);
  });

  it('doc 文档走 1.1 → 2.0 推进迁移链（label 禁升版路径不波及 doc）', () => {
    const v11 = readFixture('fixtures/templates/sales-note-v1.0.json') as Record<string, unknown>;
    v11.schemaVersion = '1.1';
    store.loadTemplate(v11 as never);
    expect(store.schemaVersion).toBe('2.0');
    expect(store.loadNote).toContain('已从 1.1 迁移至 2.0');
    expect(store.validationValid).toBe(true);
  });

  it('label 文档宽容挂载：1.1 违规内容（size:0）挂载成功但校验红（编辑器修错语义，保存门禁拦）', () => {
    const bad = readFixture('fixtures/templates/shelf-label-v1.0.json') as Record<string, unknown>;
    bad.schemaVersion = '1.1';
    expect(store.loadTemplate(bad as never)).toBe(true);
    expect(store.schemaVersion).toBe('1.1');
    expect(store.validationValid).toBe(false);
    expect(
      store.validationErrors.some((e) => e.code === 'minimum' && e.path.includes('size')),
    ).toBe(true);
  });

  it('v2.0 模板恒等加载（无迁移提示）', () => {
    store.loadTemplate(readFixture('fixtures/templates/inventory-report-v2.0.json'));
    expect(store.schemaVersion).toBe('2.0');
    expect(store.loadNote).toBeNull();
    expect(store.dsl?.code).toBe('INVENTORY_REPORT');
    expect(store.validationValid).toBe(true);
  });

  it('缺失 schemaVersion 的定稿前模板走 0.9 → 2.0 全链', () => {
    const legacy = readFixture('fixtures/templates/migration-legacy-v09.json');
    store.loadTemplate(legacy);
    expect(store.schemaVersion).toBe('2.0');
    expect(store.loadNote).toContain('0.9');
    expect(store.dsl).not.toBeNull();
  });

  it('非法对象不挂载并写 loadNote', () => {
    store.loadTemplate({ schemaVersion: '3.0' }); // 降级迁移 → RangeError
    expect(store.dsl).toBeNull();
    expect(store.loadNote).toContain('模板加载失败');
    expect(store.schemaVersion).toBeNull();
  });

  it('updateSelected 后 revalidate 刷新错误（保存门禁联动）', () => {
    store.loadTemplate(readFixture('fixtures/templates/inventory-report-v2.0.json'));
    expect(store.validationValid).toBe(true);
    store.select(1); // 8 列 table
    store.updateSelected({ source: 'nope' });
    expect(store.validationValid).toBe(false);
    expect(store.validationErrors.some((e) => e.code === 'table-source-unknown')).toBe(true);
    store.updateSelected({ source: 'items' });
    expect(store.validationValid).toBe(true);
  });
});
