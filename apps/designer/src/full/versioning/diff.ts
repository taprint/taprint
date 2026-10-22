// SPDX-License-Identifier: Apache-2.0
// 版本差异纯函数：dslHash 相等判定 → 字段级三态差异。
// 只读消费内核 DslParser.hash/stringify（规范化口径三端一致）；不依赖 DOM，可单测。
//
// 语义：
// - 第一道判定：DslParser.hash(before) === DslParser.hash(after) → { equal: true, changes: [] }；
// - 不等时递归对比（key 全深度字典序），叶子按 DslParser.stringify 规范化逐字比对；
// - 三态：added（仅新侧存在）/ removed（仅旧侧存在）/ modified（双侧存在但规范化值不等）；
// - 数组：公共下标逐元素递归；长度不等时在数组路径追加一条 modified（before/after = 长度）；
// - 路径形态：`$` 根，对象键 `.key`，数组下标 `[i]`（与 DslValidator 的 JSON path 风格一致）。
import { DslParser } from 'taprint';

/** 差异状态三态。 */
export type DiffState = 'added' | 'removed' | 'modified';

/** 单条字段级差异：path + 三态 + 规范化前后值（modified 的 before/after 为 DslParser.stringify 输出）。 */
export interface FieldDiff {
  path: string;
  state: DiffState;
  before?: string;
  after?: string;
}

/** diffDsl 结果：equal = dslHash 相等（第一道判定）；changes = 三态差异清单（equal 时恒空）。 */
export interface DslDiffResult {
  equal: boolean;
  changes: FieldDiff[];
}

/** 深拷贝 + 全深度 key 字典序（工具层独立实现，与内核 sortKeysDeep 同语义——diff 只读消费，不依赖内核内部）。 */
function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return v;
}

/** 叶子规范化：DslParser.stringify（紧凑 + key 字典序；数字经 ECMA 最短十进制，三端一致口径）。 */
function canon(v: unknown): string {
  return DslParser.stringify(sortKeysDeep(v) as never);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 版本 vs 版本 / 版本 vs 草稿 的字段级差异。
 * 调用方自行保证 before/after 为 JSON-safe（DSL 对象树）；hash 相等时直接短路返回。
 */
export function diffDsl(before: unknown, after: unknown): DslDiffResult {
  if (DslParser.hash(before as never) === DslParser.hash(after as never)) {
    return { equal: true, changes: [] };
  }
  const changes: FieldDiff[] = [];
  walk('$', before, after, changes);
  return { equal: false, changes };
}

function walk(path: string, before: unknown, after: unknown, changes: FieldDiff[]): void {
  const bObj = isPlainObject(before);
  const aObj = isPlainObject(after);
  if (bObj && aObj) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const k of keys) {
      const childPath = path === '$' ? k : `${path}.${k}`;
      const hasB = Object.prototype.hasOwnProperty.call(before, k);
      const hasA = Object.prototype.hasOwnProperty.call(after, k);
      if (!hasA) {
        changes.push({ path: childPath, state: 'removed', before: canon(before[k]) });
      } else if (!hasB) {
        changes.push({ path: childPath, state: 'added', after: canon(after[k]) });
      } else {
        walk(childPath, before[k], after[k], changes);
      }
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const min = Math.min(before.length, after.length);
    for (let i = 0; i < min; i++) {
      walk(`${path}[${i}]`, before[i], after[i], changes);
    }
    if (before.length !== after.length) {
      changes.push({
        path,
        state: 'modified',
        before: String(before.length),
        after: String(after.length),
      });
    }
    return;
  }
  // 叶子 / 类型不同的节点：规范化值不等即 modified（表达式文本差异逐字展示）
  const cb = canon(before);
  const ca = canon(after);
  if (cb !== ca) {
    changes.push({ path, state: 'modified', before: cb, after: ca });
  }
}
