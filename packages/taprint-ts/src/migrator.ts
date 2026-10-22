// SPDX-License-Identifier: Apache-2.0
// DSL 版本迁移（与 C#/Dart/Java 同构）。
// Phase 1-B 决策（文档留白处，v1.39 注记第 8 条锁定）：
// - 版本链为有序注册表：内置 0.9 → 1.0（DSL 定稿前模板无 schemaVersion 字段，
//   视为 0.9；hiprint 迁移入口即此路径）→ 1.1（label 域字段约定统一：仅折算
//   text.size 0 折 1 与 qrcode.size >10 折 10，其余保字段）→ 2.0（中国式报表
//   专项步骤 3：v2.0 为 1.x 严格超集，步骤仅推进版本声明，结构兼容由"全部 v1.0
//   fixture 迁移后通过 v2.0 schema"锚点锁定）；registerStep 可扩展自定义版本；
// - migrate 逐级执行步骤，每步结束断言 schemaVersion 被置为链上下一版本；
//   可选注入 schema 时每步后过 DslValidator.validate 门禁（内核不内置文件路径）；
// - detectVersion：缺 schemaVersion 归 0.9，其余按 `主.次` 文法如实上报
//   （合法性/可迁移性归 migrate 判定）；
// - migrate 入口深拷贝隔离调用方入参（JSON 语义），from == to 为恒等迁移；
//   MigrationStep 契约：纯函数，禁改入参、须返回新对象。
import type { TemplateDSL } from './types.ts';
import { DslValidator } from './validator.ts';

/** 版本文法：`主.次` 十进制数段（与 schema/changelog.md 版本列一致） */
const VERSION_RE = /^\d+\.\d+$/;

/** DSL 定稿前模板（无 schemaVersion 字段）的归档版本号 */
export const LEGACY_VERSION = '0.9';

/** 当前权威 schema 版本（schema/v2.0.json / schema/changelog.md，中国式报表专项） */
export const CURRENT_VERSION = '2.0';

/**
 * 迁移步骤契约：纯函数——禁止原地修改入参（含嵌套对象），必须返回新对象；
 * migrate 对入参做深拷贝隔离，步骤间仅以返回值传递状态。
 */
export type MigrationStep = (dsl: Record<string, unknown>) => Record<string, unknown>;

/**
 * 逐步门禁的 schema 注入形态（专项步骤 4 扩展，向后兼容）：
 * - 对象：每步后均按该 schema 校验（调用方保证它对链上全部中间版本有效）；
 * - 函数：按**该步产出版本**选 schema——多版本链（0.9→1.0→2.0）各版本
 *   schemaVersion pattern 分轨时必需。
 */
export type MigrationSchemaGate = object | ((version: string) => object);

const stepRegistry = new Map<string, MigrationStep>();

function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor] = a.split('.').map(Number);
  const [bMajor, bMinor] = b.split('.').map(Number);
  return aMajor !== bMajor ? aMajor - bMajor : aMinor - bMinor;
}

function normalizeVersion(v: string, label: string): string {
  if (typeof v !== 'string' || !VERSION_RE.test(v)) {
    throw new TypeError(`DslMigrator: ${label} 版本格式非法（须为 "主.次"）：${String(v)}`);
  }
  return v;
}

function assertObject(dsl: unknown): Record<string, unknown> {
  if (dsl === null || typeof dsl !== 'object' || Array.isArray(dsl)) {
    throw new TypeError('DslMigrator: dsl 必须为对象');
  }
  return dsl as Record<string, unknown>;
}

/** 入口深拷贝：调用方入参与迁移产物完全隔离（JSON 语义，循环引用即拒） */
function deepClone(dsl: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(dsl)) as Record<string, unknown>;
  } catch {
    throw new TypeError('DslMigrator.migrate: dsl 必须为 JSON-safe（拒绝循环引用）');
  }
}

function registerBuiltins(): void {
  // 0.9 → 1.0：DSL 权威定稿（Phase 0）。结构兼容，仅补版本声明。
  stepRegistry.set(LEGACY_VERSION, (dsl) => ({ ...dsl, schemaVersion: '1.0' }));
  // 1.0 → 1.1：label 域字段约定统一（schema/changelog.md v1.1 行）。仅折算两处
  // 收窄值——text.size 0 折 1、qrcode.size >10 折 10（D4：PC 引擎与后端 TSPL
  // 渲染早已按 1-10 clamp，本步把存量文档折进新值域）；其余字段原样保留（保字段
  // 铁律：1.0 文档无 v1.1 新增字段，本步不产生也不丢失任何字段）。
  stepRegistry.set('1.0', (dsl) => normalizeLabelV11({ ...dsl, schemaVersion: '1.1' }));
  // 1.1 → 2.0：中国式报表专项步骤 3（v2.0 为 1.x 严格超集）。v1.1 同批已把
  // label 六元素/收窄落稿同步进 v2.0，步骤仅推进版本声明；结构兼容由锚点锁定
  // （migrator.spec：全部 v1.0 fixture 迁移后通过 v2.0 schema）。
  stepRegistry.set('1.1', (dsl) => ({ ...dsl, schemaVersion: '2.0' }));
}

/**
 * 1.0 → 1.1 折算（纯函数，禁改入参嵌套对象）：遍历 presentations.label.body——
 * text 元素 size===0 → 1；qrcode 元素 size>10 → 10
 * 。其余元素与字段一律原样保留。
 */
function normalizeLabelV11(dsl: Record<string, unknown>): Record<string, unknown> {
  const pres = dsl.presentations;
  if (pres === null || typeof pres !== 'object' || Array.isArray(pres)) return dsl;
  const label = (pres as Record<string, unknown>).label;
  if (label === null || typeof label !== 'object' || Array.isArray(label)) return dsl;
  const body = (label as Record<string, unknown>).body;
  if (!Array.isArray(body)) return dsl;
  const normalizedBody = body.map((el) => {
    if (el === null || typeof el !== 'object' || Array.isArray(el)) return el;
    const src = el as Record<string, unknown>;
    if (src.type === 'text' && src.size === 0) return { ...src, size: 1 };
    if (src.type === 'qrcode' && typeof src.size === 'number' && src.size > 10) {
      return { ...src, size: 10 };
    }
    return src;
  });
  const normalizedLabel = { ...(label as Record<string, unknown>), body: normalizedBody };
  return { ...dsl, presentations: { ...(pres as Record<string, unknown>), label: normalizedLabel } };
}

registerBuiltins();

export class DslMigrator {
  /**
   * 从旧版本逐级迁移到目标版本。
   * 入口深拷贝隔离入参；schema 注入时每步后经 DslValidator.validate 门禁；
   * from == to 为恒等迁移（返回深拷贝）。
   */
  static migrate(
    dsl: unknown,
    fromVersion: string,
    toVersion: string,
    schema?: MigrationSchemaGate,
  ): TemplateDSL {
    const from = normalizeVersion(fromVersion, 'fromVersion');
    const to = normalizeVersion(toVersion, 'toVersion');
    if (compareVersions(from, to) > 0) {
      throw new RangeError(`DslMigrator.migrate: 不支持降级迁移（${from} → ${to}）`);
    }
    let current = deepClone(assertObject(dsl));
    let version = from;
    while (compareVersions(version, to) < 0) {
      const step = stepRegistry.get(version);
      if (!step) {
        throw new Error(
          `DslMigrator.migrate: 版本 ${version} 无已注册迁移步骤（迁移链断裂，目标 ${to}）`,
        );
      }
      current = { ...step(current) };
      const next = current.schemaVersion;
      if (typeof next !== 'string' || compareVersions(next, version) <= 0) {
        throw new Error(
          `DslMigrator.migrate: ${version} 迁移步骤未将 schemaVersion 推进（得到 ${String(next)}）`,
        );
      }
      if (compareVersions(next, to) > 0) {
        throw new Error(
          `DslMigrator.migrate: ${version} 迁移步骤越过目标版本（推进至 ${next}，目标 ${to}）`,
        );
      }
      version = next;
      if (schema) {
        // 函数形态按该步产出版本选 schema（pattern 分轨链必需）；对象形态逐步同 schema
        const gateSchema = typeof schema === 'function' ? schema(version) : schema;
        const result = DslValidator.validate(current as TemplateDSL, gateSchema);
        if (!result.valid) {
          throw new Error(
            `DslMigrator.migrate: 迁移至 ${version} 后未通过 schema 校验：${result.errors[0]?.message ?? '未知错误'}`,
          );
        }
      }
    }
    return current as TemplateDSL;
  }

  /** 检测模板版本：缺 schemaVersion 归 0.9（定稿前模板）；否则按文法如实上报 */
  static detectVersion(dsl: unknown): string {
    const obj = assertObject(dsl);
    const v = obj.schemaVersion;
    if (v === undefined) return LEGACY_VERSION;
    if (typeof v !== 'string' || !VERSION_RE.test(v)) {
      throw new TypeError(`DslMigrator.detectVersion: schemaVersion 不可识别：${String(v)}`);
    }
    return v;
  }

  /**
   * 注册迁移步骤（fromVersion → 步骤内声明的下一版本；重复注册覆写）。
   * 风险声明：覆写内置 0.9 步骤会改变**所有**定稿前模板的迁移路径——
   * 生产环境仅在有明确迁移策略变更时使用；clear() 可恢复内置链。
   */
  static registerStep(fromVersion: string, step: MigrationStep): void {
    const from = normalizeVersion(fromVersion, 'fromVersion');
    if (typeof step !== 'function') {
      throw new TypeError('DslMigrator.registerStep: step 必须为函数');
    }
    stepRegistry.set(from, step);
  }

  /** 恢复内置迁移链（0.9 → 1.0 → 1.1 → 2.0）；测试隔离 / 宿主生命周期用 */
  static clear(): void {
    stepRegistry.clear();
    registerBuiltins();
  }
}
