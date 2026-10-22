// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_VERSION,
  DslMigrator,
  DslValidator,
  LEGACY_VERSION,
  type TemplateDSL,
} from '../src/index';

// Phase 1-B：迁移链与 schema/changelog.md 对齐；migration fixture 为跨语言一致性锚点
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturesDir = resolve(repoRoot, 'fixtures/templates');
const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(resolve(repoRoot, rel), 'utf8')) as unknown;

const legacyFixture = () => readJson('fixtures/templates/migration-legacy-v09.json');
const expectedResult = () => readJson('fixtures/expected/parse-results/migration-legacy-v09-result.json');
const v10Fixture = () => readJson('fixtures/templates/migration-v10.json');
const v10ExpectedResult = () => readJson('fixtures/expected/parse-results/migration-v10-result.json');
const schema = () => readJson('schema/v1.0.json') as object;
const schemaV2 = () => readJson('schema/v2.0.json') as object;

describe('DslMigrator.detectVersion', () => {
  it('业务 fixture 报 1.0；v2 fixture 报 2.0；无 schemaVersion 的定稿前模板归 0.9', () => {
    expect(DslMigrator.detectVersion(readJson('fixtures/templates/sales-note-v1.0.json'))).toBe('1.0');
    expect(DslMigrator.detectVersion(readJson('fixtures/templates/inventory-report-v2.0.json'))).toBe(
      '2.0',
    );
    expect(DslMigrator.detectVersion(legacyFixture())).toBe(LEGACY_VERSION);
  });

  it('非对象抛 TypeError；schemaVersion 非文法值抛 TypeError', () => {
    expect(() => DslMigrator.detectVersion(null)).toThrow(TypeError);
    expect(() => DslMigrator.detectVersion([1])).toThrow(TypeError);
    expect(() => DslMigrator.detectVersion({ schemaVersion: 1 })).toThrow(TypeError);
    expect(() => DslMigrator.detectVersion({ schemaVersion: 'v1' })).toThrow('不可识别');
  });
});

describe('DslMigrator.migrate（内置 0.9 → 1.0 → 2.0 链）', () => {
  afterEach(() => DslMigrator.clear());

  it('0.9→1.0 锚点：迁移结果与 expected-output 逐字一致（停在中间步，三端锚点）', () => {
    const migrated = DslMigrator.migrate(legacyFixture(), LEGACY_VERSION, '1.0');
    expect(migrated).toEqual(expectedResult());
    expect(migrated.schemaVersion).toBe('1.0');
  });

  it('迁移后经 DslValidator.validate 通过对应版本权威 schema', () => {
    const migrated = DslMigrator.migrate(legacyFixture(), LEGACY_VERSION, '1.0');
    expect(DslValidator.validate(migrated, schema()).valid).toBe(true);
    const migratedV2 = DslMigrator.migrate(v10Fixture(), '1.0', CURRENT_VERSION);
    expect(DslValidator.validate(migratedV2, schemaV2()).valid).toBe(true);
  });

  it('恒等迁移（from == to）返回深拷贝：顶层与嵌套均不改入参', () => {
    const src = readJson('fixtures/templates/sales-note-v1.0.json') as TemplateDSL;
    const out = DslMigrator.migrate(src, '1.0', '1.0');
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
    (out as Record<string, unknown>).name = 'tampered';
    expect(src.name).toBe('销售单-A4-标准');
    type DocBody = { presentations: { doc: { body: Array<Record<string, unknown>> } } };
    const outBody = (out as unknown as DocBody).presentations.doc.body;
    outBody[0].content = 'tampered';
    const srcBody = (src as unknown as DocBody).presentations.doc.body;
    expect(srcBody[0].content).not.toBe('tampered');
  });

  it('入口深拷贝隔离：0.9→1.0 迁移产物的嵌套修改不波及入参', () => {
    const src = legacyFixture() as Record<string, unknown>;
    const before = JSON.stringify(src);
    const out = DslMigrator.migrate(src, LEGACY_VERSION, CURRENT_VERSION) as unknown as Record<
      string,
      Record<string, unknown>
    >;
    out.presentations.doc = {};
    expect(JSON.stringify(src)).toBe(before);
  });

  it('版本文法/方向防御：非法格式、降级、断链均拒', () => {
    expect(() => DslMigrator.migrate({}, 'v1', '1.0')).toThrow(TypeError);
    expect(() => DslMigrator.migrate({}, '1.0', '0.9')).toThrow(RangeError);
    expect(() => DslMigrator.migrate({}, '2.0', '2.1')).toThrow('迁移链断裂');
    expect(() => DslMigrator.migrate([1], '0.9', '1.0')).toThrow(TypeError);
  });

  it('注入 schema 时每步后过校验门禁（坏步骤产出非法 DSL 即拒）', () => {
    DslMigrator.registerStep('1.0', (dsl) => ({ ...dsl, schemaVersion: '1.1', name: 42 }));
    expect(() => DslMigrator.migrate({ schemaVersion: '1.0' }, '1.0', '1.1', schema())).toThrow(
      '未通过 schema 校验',
    );
  });

  it('函数形态门禁按步产出版本选 schema（pattern 分轨链必需，专项步骤 4）', () => {
    const gate = (v: string): object => (v.startsWith('2.') ? schemaV2() : schema());
    // 对象形态注入 v2 schema 会在 1.0 中间步被 `^2.x` pattern 拒绝；函数形态放行
    expect(() =>
      DslMigrator.migrate(legacyFixture(), LEGACY_VERSION, CURRENT_VERSION, schemaV2()),
    ).toThrow('未通过 schema 校验');
    const migrated = DslMigrator.migrate(legacyFixture(), LEGACY_VERSION, CURRENT_VERSION, gate);
    expect(migrated.schemaVersion).toBe('2.0');
    // 坏步骤在函数形态下同样被拦（1.0 步产出按 v1.0 schema 判）
    DslMigrator.registerStep(LEGACY_VERSION, (dsl) => ({ ...dsl, schemaVersion: '1.0', id: 1 }));
    expect(() => DslMigrator.migrate(legacyFixture(), LEGACY_VERSION, '1.0', gate)).toThrow(
      '未通过 schema 校验',
    );
  });

  it('registerStep 扩展自定义链（1.0 → 1.1 → 2.0 逐级推进）', () => {
    DslMigrator.registerStep('1.0', (dsl) => ({ ...dsl, schemaVersion: '1.1', migratedA: true }));
    DslMigrator.registerStep('1.1', (dsl) => ({ ...dsl, schemaVersion: '2.0', migratedB: true }));
    const out = DslMigrator.migrate({ schemaVersion: '1.0' }, '1.0', '2.0') as Record<
      string,
      unknown
    >;
    expect(out).toEqual({ schemaVersion: '2.0', migratedA: true, migratedB: true });
  });

  it('步骤未推进 / 越过目标 / 重复步幅均拒', () => {
    DslMigrator.registerStep('1.0', (dsl) => ({ ...dsl, schemaVersion: '1.0' }));
    expect(() => DslMigrator.migrate({ schemaVersion: '1.0' }, '1.0', '2.0')).toThrow(
      '未将 schemaVersion 推进',
    );
    DslMigrator.registerStep('1.0', (dsl) => ({ ...dsl, schemaVersion: '3.0' }));
    expect(() => DslMigrator.migrate({ schemaVersion: '1.0' }, '1.0', '2.0')).toThrow(
      '越过目标版本',
    );
  });

  it('clear 恢复内置链（自定义步骤不残留）', () => {
    DslMigrator.registerStep('1.0', (dsl) => ({ ...dsl, schemaVersion: '9.9' }));
    DslMigrator.clear();
    const out = DslMigrator.migrate(legacyFixture(), LEGACY_VERSION, CURRENT_VERSION);
    expect(out.schemaVersion).toBe('2.0');
    expect(() => DslMigrator.migrate({ schemaVersion: '1.0' }, '1.0', '9.9')).toThrow('迁移链断裂');
  });
});

describe('DslMigrator.migrate（1.0 → 1.1，label 域字段约定统一）', () => {
  afterEach(() => DslMigrator.clear());

  const labelDoc = (body: Array<Record<string, unknown>>): Record<string, unknown> => ({
    schemaVersion: '1.0',
    id: 'tpl_label_v11_probe',
    code: 'LABEL_V11_PROBE',
    name: 'v1.1 折算探针',
    presentations: {
      label: {
        size: { width: '40mm', height: '30mm' },
        body,
      },
    },
  });

  it('text.size 0 折 1；qrcode.size >10 折 10；其余元素与字段保字段', () => {
    const src = labelDoc([
      { type: 'text', content: '{{name}}', x: '2mm', y: '2mm', font: 'SIMPLIFIED CHINESE', size: 0 },
      { type: 'text', content: '{{price}}', x: '2mm', y: '12mm', size: 3 },
      { type: 'qrcode', content: '{{sku}}', x: '30mm', y: '20mm', size: 15 },
      { type: 'qrcode', content: '{{sku}}', x: '30mm', y: '20mm', size: 4 },
      { type: 'barcode', content: '{{sku}}', symbology: 'EAN13', x: '2mm', y: '20mm', height: '8mm' },
    ]);
    const out = DslMigrator.migrate(src as unknown as never, '1.0', '1.1') as unknown as {
      schemaVersion: string;
      presentations: { label: { body: Array<Record<string, unknown>> } };
    };
    expect(out.schemaVersion).toBe('1.1');
    const body = out.presentations.label.body;
    expect(body[0].size).toBe(1); // 0 折 1，font 等字段保留
    expect(body[0].font).toBe('SIMPLIFIED CHINESE');
    expect(body[1].size).toBe(3); // 合法值原样
    expect(body[2].size).toBe(10); // >10 折 10（D4 降档事实）
    expect(body[3].size).toBe(4); // 合法值原样
    expect(body[4]).toEqual((src as Record<string, unknown> & { presentations: { label: { body: unknown[] } } }).presentations.label.body[4]); // barcode 原样
  });

  it('无 label 呈现的文档仅推进版本声明（golden 锚点：v1.0 fixture 到 1.1 结构逐字不变）', () => {
    const migrated = DslMigrator.migrate(v10Fixture(), '1.0', '1.1');
    expect(migrated.schemaVersion).toBe('1.1');
    const { schemaVersion: _a, ...restMigrated } = migrated as Record<string, unknown>;
    const { schemaVersion: _b, ...restSource } = v10Fixture() as Record<string, unknown>;
    expect(restMigrated).toEqual(restSource);
  });

  it('入参嵌套对象不被改写（纯函数契约在折算路径同样成立）', () => {
    const src = labelDoc([
      { type: 'text', content: '{{name}}', x: '2mm', y: '2mm', size: 0 },
    ]);
    const before = JSON.stringify(src);
    DslMigrator.migrate(src, '1.0', '1.1');
    expect(JSON.stringify(src)).toBe(before);
  });

  it('折算产物过 v1.1 schema；全链 1.0→2.0 过 v2.0 schema（超集同构）', () => {
    const schemaV11 = () => readJson('schema/v1.1.json') as object;
    const src = labelDoc([
      { type: 'text', content: '{{name}}', x: '2mm', y: '2mm', size: 0 },
      { type: 'qrcode', content: '{{sku}}', x: '30mm', y: '20mm', size: 20 },
    ]);
    const to11 = DslMigrator.migrate(src, '1.0', '1.1');
    expect(DslValidator.validate(to11, schemaV11()).errors).toEqual([]);
    const to20 = DslMigrator.migrate(src, '1.0', CURRENT_VERSION);
    expect(DslValidator.validate(to20, schemaV2()).errors).toEqual([]);
  });
});

describe('DslMigrator.migrate（1.0 → 2.0，中国式报表专项步骤 3）', () => {
  afterEach(() => DslMigrator.clear());

  it('golden 锚点：迁移结果与 expected-output 逐字一致（仅 schemaVersion 推进）', () => {
    const migrated = DslMigrator.migrate(v10Fixture(), '1.0', CURRENT_VERSION);
    expect(migrated).toEqual(v10ExpectedResult());
    expect(migrated.schemaVersion).toBe('2.0');
    // 超集承诺：除 schemaVersion 外结构逐字不变
    const { schemaVersion: _a, ...restMigrated } = migrated as Record<string, unknown>;
    const { schemaVersion: _b, ...restSource } = v10Fixture() as Record<string, unknown>;
    expect(restMigrated).toEqual(restSource);
  });

  it('全链 0.9 → 2.0 逐级推进（major 跨越），产物过 v2.0 schema', () => {
    const migrated = DslMigrator.migrate(legacyFixture(), LEGACY_VERSION, CURRENT_VERSION);
    expect(migrated.schemaVersion).toBe('2.0');
    expect(DslValidator.validate(migrated, schemaV2()).valid).toBe(true);
  });

  it('超集门禁：全部 v1.0 业务 fixture 迁移到 2.0 后通过 v2.0 schema', () => {
    const bizFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('-v1.0.json'));
    expect(bizFiles.length).toBeGreaterThanOrEqual(10);
    for (const file of bizFiles) {
      const migrated = DslMigrator.migrate(
        JSON.parse(readFileSync(resolve(fixturesDir, file), 'utf8')) as unknown,
        '1.0',
        CURRENT_VERSION,
      );
      const result = DslValidator.validate(migrated, schemaV2());
      expect(result.errors, file).toEqual([]);
    }
  });

  it('v2.0 模板恒等迁移（2.0 → 2.0）；目标低于 2.0 的降级拒绝', () => {
    const v2 = readJson('fixtures/templates/inventory-report-v2.0.json');
    const out = DslMigrator.migrate(v2, '2.0', '2.0');
    expect(out).toEqual(v2);
    expect(() => DslMigrator.migrate(v2, '2.0', '1.0')).toThrow(RangeError);
  });
});
