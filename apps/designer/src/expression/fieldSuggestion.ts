// SPDX-License-Identifier: Apache-2.0
// 字段智能提示（，设计契约 后续轮）：展平模板 dataSources 与
// parameters 为补全候选。纯函数无 monaco 依赖（jsdom 可测）；monaco 补全 provider
// 在 ExpressionEditor.vue 挂接。路径口径与内核 fieldPathsOf 一致，但补全 insertText
// 去掉 `[*]` 展示前缀（表达式文法用 `items[0].sku`/`items.sku`，`[*]` 不参与文法）。

export interface FieldSuggestion {
  /** 表达式内可插入的裸路径（detail 源不带 [*] 前缀） */
  path: string;
  /** 所属数据源名；parameters 为 'parameters' */
  source: string;
  kind: 'field' | 'param';
}

interface DataSourceLike {
  name?: unknown;
  type?: unknown;
  schema?: unknown;
}

/** schema 叶子路径展平（叶子 = 非 plain-object 值，含类型字符串）；字段提示与预览 mockData 共用 */
export function flattenSchema(node: Record<string, unknown>, prefix: string, out: string[]): void {
  for (const [key, value] of Object.entries(node)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenSchema(value as Record<string, unknown>, `${prefix}${key}.`, out);
    } else {
      out.push(`${prefix}${key}`);
    }
  }
}

/** 模板数据源 + parameters → 补全候选（去重，字段字典序）；容忍任意形状输入（宿主数据不信任边界） */
export function collectFieldSuggestions(dsl: Record<string, unknown> | null): FieldSuggestion[] {
  if (!dsl || typeof dsl !== 'object') return [];
  const out: FieldSuggestion[] = [];
  const seen = new Set<string>();
  const record = dsl;
  const sources = record.dataSources;
  if (Array.isArray(sources)) {
    for (const raw of sources as DataSourceLike[]) {
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof raw.name !== 'string' ||
        !raw.schema ||
        typeof raw.schema !== 'object'
      ) {
        continue;
      }
      const paths: string[] = [];
      flattenSchema(raw.schema as Record<string, unknown>, '', paths);
      for (const p of paths) {
        if (!seen.has(p)) {
          seen.add(p);
          out.push({ path: p, source: raw.name, kind: 'field' });
        }
      }
    }
  }
  const parameters = record.parameters;
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    for (const key of Object.keys(parameters as Record<string, unknown>).sort()) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ path: key, source: 'parameters', kind: 'param' });
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** 从候选列表筛选前缀匹配（monaco completions 过滤口径：路径段前缀，大小写不敏感） */
export function filterSuggestions(list: FieldSuggestion[], prefix: string): FieldSuggestion[] {
  const p = prefix.toLowerCase();
  if (!p) return list;
  return list.filter((s) => s.path.toLowerCase().includes(p));
}
