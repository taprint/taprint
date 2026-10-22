// SPDX-License-Identifier: Apache-2.0
// 规范化 JSON（canonical JSON）：全深度递归 key 字典序 + JSON-safe 断言。
// MessageSigner.canonicalize 与 DslParser.stringify/hash 共用同一套规则，
// 保证包内 canonical 语义唯一。
// 循环检测按「当前路径上的祖先集合」回溯：
// DAG 形共享子对象（非循环）不误报，真循环仍抛 TypeError。
export function assertJsonSafe(v: unknown, path: string, seen?: WeakSet<object>): void {
  if (v === null) return;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return;
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new TypeError(`非 JSON-safe 值（${t}）位于 ${path}`);
  }
  const visited = seen ?? new WeakSet<object>();
  if (visited.has(v as object)) {
    throw new TypeError(`循环引用位于 ${path}`);
  }
  visited.add(v as object);
  if (Array.isArray(v)) {
    v.forEach((item, i) => assertJsonSafe(item, `${path}[${i}]`, visited));
    visited.delete(v as object);
    return;
  }
  const proto = Object.getPrototypeOf(v) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      `非纯对象（${(v as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'}）位于 ${path}`,
    );
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    assertJsonSafe(val, `${path}.${k}`, visited);
  }
  visited.delete(v as object);
}

export function sortKeysDeep(v: unknown): unknown {
  // 注意：tools/schema-lint.ts 存在逐字同语义的孪生实现（工具层刻意解耦），修改需同步。
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
