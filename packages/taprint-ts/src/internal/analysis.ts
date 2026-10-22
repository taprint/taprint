// SPDX-License-Identifier: Apache-2.0
// DSL 静态分析：数据源字段路径展平 + 表达式收集。
// DslParser.parseResult 与 DslValidator.validateBusiness 共用（Phase 1-A）。
import type { TemplateDSL } from '../types.ts';

export interface DataSourceInfo {
  name: string;
  type: string;
  schema: Record<string, unknown>;
}

/** 表达式出现位置：path 为 JSON path，raw 为完整 {{...}}，ref 为 {{}} 内表达式全文（trim 后） */
export interface ExpressionOccurrence {
  path: string;
  raw: string;
  ref: string;
}

// 表达式文法校验自 v1.41 起移交 ExpressionCompiler.compile。

const EXPR_RE = /\{\{([^{}]+)\}\}/g;

export function dataSourcesOf(dsl: TemplateDSL): DataSourceInfo[] {
  const list = (dsl as Record<string, unknown>).dataSources;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (ds): ds is DataSourceInfo =>
      !!ds &&
      typeof ds === 'object' &&
      typeof (ds as DataSourceInfo).name === 'string' &&
      typeof (ds as DataSourceInfo).schema === 'object' &&
      (ds as DataSourceInfo).schema !== null,
  );
}

/**
 * 展平字段字典为点路径。
 * detail 源的路径带 `<name>[*].` 前缀（行集合语义，与 parse-result 示例一致）。
 */
export function fieldPathsOf(dsl: TemplateDSL): string[] {
  const out: string[] = [];
  for (const ds of dataSourcesOf(dsl)) {
    const prefix = ds.type === 'detail' ? `${ds.name}[*].` : '';
    flattenSchema(ds.schema, prefix, out);
  }
  return [...new Set(out)].sort();
}

function flattenSchema(node: Record<string, unknown>, prefix: string, out: string[]): void {
  for (const [key, value] of Object.entries(node)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenSchema(value as Record<string, unknown>, `${prefix}${key}.`, out);
    } else {
      out.push(`${prefix}${key}`);
    }
  }
}

/** 收集 presentations 内全部 {{...}} 表达式（parameters/dataSources 不在渲染面，不计） */
export function expressionsOf(dsl: TemplateDSL): ExpressionOccurrence[] {
  const out: ExpressionOccurrence[] = [];
  walk((dsl as Record<string, unknown>).presentations, 'presentations', out);
  return out;
}

function walk(v: unknown, path: string, out: ExpressionOccurrence[]): void {
  if (typeof v === 'string') {
    for (const m of v.matchAll(EXPR_RE)) {
      out.push({ path, raw: m[0], ref: m[1].trim() });
    }
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((item, i) => walk(item, `${path}[${i}]`, out));
    return;
  }
  if (v !== null && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      walk(val, `${path}.${k}`, out);
    }
  }
}

/** 字段引用解析结论：ok=可解析；unknown=无处可解析；ambiguous=裸路径命中多个数据源 */
export type RefVerdict = 'ok' | 'unknown' | 'ambiguous';

/** 顶层 parameters 名称集 */
export function paramNamesOf(dsl: TemplateDSL): Set<string> {
  const list = (dsl as Record<string, unknown>).parameters;
  if (!Array.isArray(list)) return new Set();
  return new Set(
    list
      .filter(
        (p): p is { name: string } =>
          !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string',
      )
      .map((p) => p.name),
  );
}

/**
 * 字段引用可解析性（十轮规范裁决：多源同名裸路径不再静默放行）：
 * 1) 首段为数据源名 → 余下路径须存在于该源 schema（单段即整源聚合引用，如 items | sum:'amount'）；
 * 2) 否则裸路径恰命中一个数据源 schema → ok（fixture 惯例：主源字段免前缀）；
 * 3) 裸路径命中 ≥2 个源 → ambiguous（要求写源前缀消歧）；
 * 4) 数据源均未命中 → 查 parameters 名称（运行时参数，如 copies/printer）。
 * 数组索引段（items.0.sku ⇔ items[0].sku，extractFields 输出形态）在校验前剥离。
 */
export function classifyRef(
  ref: string,
  sources: DataSourceInfo[],
  paramNames: Set<string> = new Set(),
): RefVerdict {
  const normalized = ref
    .split('.')
    .filter((seg) => !/^\d+$/.test(seg))
    .join('.');
  if (!normalized) return 'unknown';
  const segments = normalized.split('.');
  const byName = sources.find((ds) => ds.name === segments[0]);
  if (byName) {
    if (segments.length === 1) return 'ok';
    return barePathsOf(byName.schema).has(segments.slice(1).join('.')) ? 'ok' : 'unknown';
  }
  const matches = sources.filter((ds) => barePathsOf(ds.schema).has(normalized));
  if (matches.length === 1) return 'ok';
  if (matches.length > 1) return 'ambiguous';
  return paramNames.has(normalized) ? 'ok' : 'unknown';
}

function barePathsOf(schema: Record<string, unknown>): Set<string> {
  const out: string[] = [];
  flattenSchema(schema, '', out);
  return new Set(out);
}
