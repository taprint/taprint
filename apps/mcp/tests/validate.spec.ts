// SPDX-License-Identifier: Apache-2.0
// validate_template 工具测试：合法/非法模板、业务规则、schema 版本门、宿主函数审计。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateTemplate } from '../src/tools/validate.ts';

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../fixtures/templates/${name}`, import.meta.url)),
      'utf8',
    ),
  );

const shelfLabel = () => fixture('shelf-label-v1.0.json');
const receipt = () => fixture('esc-pos-receipt-v1.0.json');

describe('validate_template', () => {
  it('合法模板（货架标签 v1.0）→ valid:true、errors 空', () => {
    const out = validateTemplate({ template: shelfLabel() });
    expect(out.valid).toBe(true);
    expect(out.errors).toEqual([]);
  });

  it('合法收据模板（含 kvtable/table/过滤器表达式）→ valid:true', () => {
    const out = validateTemplate({ template: receipt() });
    expect(out.valid).toBe(true);
  });

  it('缺 presentations（schema 必填）→ valid:false 且错误带 JSON path 与 code', () => {
    const tpl = shelfLabel();
    delete (tpl as Record<string, unknown>).presentations;
    const out = validateTemplate({ template: tpl });
    expect(out.valid).toBe(false);
    expect(out.errors.length).toBeGreaterThan(0);
    for (const e of out.errors) {
      expect(typeof e.path).toBe('string');
      expect(typeof e.code).toBe('string');
      expect(e.message.length).toBeGreaterThan(0);
    }
    expect(out.errors.some((e) => `${e.path} ${e.message}`.includes('presentations'))).toBe(true);
  });

  it('未知 schemaVersion → unsupported-schema-version 单错误', () => {
    const tpl = { ...shelfLabel(), schemaVersion: '0.9' };
    const out = validateTemplate({ template: tpl });
    expect(out.valid).toBe(false);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].code).toBe('unsupported-schema-version');
    expect(out.errors[0].path).toBe('$.schemaVersion');
  });

  it('表达式引用未定义字段 → unknown-field（内核 validateBusiness 接入）', () => {
    const tpl = shelfLabel();
    const label = (tpl as Record<string, unknown>).presentations as Record<string, unknown>;
    const body = (label.label as Record<string, unknown>).body as Array<Record<string, unknown>>;
    body[0] = { ...body[0], content: '{{notAField}}' };
    const out = validateTemplate({ template: tpl });
    expect(out.valid).toBe(false);
    expect(out.errors.some((e) => e.code === 'unknown-field')).toBe(true);
  });

  it('表达式文法非法 → bad-expression', () => {
    const tpl = shelfLabel();
    const label = (tpl as Record<string, unknown>).presentations as Record<string, unknown>;
    const body = (label.label as Record<string, unknown>).body as Array<Record<string, unknown>>;
    body[0] = { ...body[0], content: '{{price +++}}' };
    const out = validateTemplate({ template: tpl });
    expect(out.errors.some((e) => e.code === 'bad-expression')).toBe(true);
  });

  it('宿主函数审计：未登记的 call → unknown-host-function；hostFunctions 登记后通过', () => {
    const tpl = shelfLabel();
    const label = (tpl as Record<string, unknown>).presentations as Record<string, unknown>;
    const body = (label.label as Record<string, unknown>).body as Array<Record<string, unknown>>;
    body[0] = { ...body[0], content: '{{tenantName()}}: {{name}}' };
    const dataSources = tpl.dataSources as Array<Record<string, unknown>>;
    const schema = dataSources[0].schema as Record<string, unknown>;
    schema.tenantName = 'string'; // 让字段绑定通过，只考验函数审计

    const bad = validateTemplate({ template: structuredClone(tpl) });
    expect(bad.valid).toBe(false);
    expect(bad.errors.some((e) => e.code === 'unknown-host-function')).toBe(true);

    const good = validateTemplate({ template: structuredClone(tpl), hostFunctions: ['tenantName'] });
    expect(good.valid).toBe(true);
  });
});
