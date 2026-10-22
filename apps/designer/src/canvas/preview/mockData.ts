// SPDX-License-Identifier: Apache-2.0
// 预览 mock 数据（M2 预览仿真块 A）：按 dataSources schema + parameters 生成确定性
// 示例数据。挂载口径对齐内核 evaluate 路径解析（expression-compiler.spec）：裸路径查根、
// 带源名前缀查 data[源名]——故 primary/master 源字段「根级平铺 + 源名嵌套」双挂，
// detail 源整数组挂源名键（`items | sum:'amount'` 单段聚合引用可用）。
//
// ── 取值映射表──
// string → `示例-${path}`（含字段路径，多字段可辨识）
// number → 12.5 + 行号（detail 各行微变：12.5/13.5/14.5）
// integer → 12 + 行号
// boolean → true
// date → '2026-01-15'（固定日期而非当前日期：golden 确定性）
// 未知/其他类型 → 按 string 口径兜底
// parameters → 有 default 取 default（含显式 null）；缺省按上表类型兜底
import { flattenSchema } from '../../expression/fieldSuggestion';

interface DataSourceLike {
  name?: unknown;
  type?: unknown;
  schema?: unknown;
}

interface ParameterLike {
  name?: unknown;
  type?: unknown;
  default?: unknown;
}

/** detail 仿真行数（三轮足够展示循环/表格语义，且保持预览体量小） */
const DETAIL_ROWS = 3;

function leafTypeAt(schema: Record<string, unknown>, path: string): unknown {
  let node: unknown = schema;
  for (const seg of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

/** 类型字符串 → 确定性示例值；rowIndex 让 detail 各行数值可辨识 */
function mockValue(type: unknown, path: string, rowIndex: number): unknown {
  switch (typeof type === 'string' ? type : 'string') {
    case 'number':
      return Number((12.5 + rowIndex).toFixed(2));
    case 'integer':
      return 12 + rowIndex;
    case 'boolean':
      return true;
    case 'date':
      return '2026-01-15';
    default:
      return `示例-${path}`;
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  let node = target;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const key = segs[i];
    const next = node[key];
    if (!next || typeof next !== 'object') {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[segs[segs.length - 1]] = value;
}

function buildRows(source: DataSourceLike): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let r = 0; r < DETAIL_ROWS; r += 1) {
    const row: Record<string, unknown> = {};
    const paths: string[] = [];
    flattenSchema(source.schema as Record<string, unknown>, '', paths);
    for (const p of paths) {
      setPath(row, p, mockValue(leafTypeAt(source.schema as Record<string, unknown>, p), p, r));
    }
    rows.push(row);
  }
  return rows;
}

/** 模板 → 预览用 mock 数据（取值规则见文件头映射表，确定性非随机）；容忍任意形状输入（宿主数据不信任边界），失败返回空对象 */
export function provideMockData(dsl: unknown): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (!dsl || typeof dsl !== 'object') return data;
  const sources = (dsl as Record<string, unknown>).dataSources;
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
      if (raw.type === 'detail') {
        data[raw.name] = buildRows(raw);
        continue;
      }
      // primary/master：根级平铺 + 源名嵌套双挂
      const nested: Record<string, unknown> = {};
      const paths: string[] = [];
      flattenSchema(raw.schema as Record<string, unknown>, '', paths);
      for (const p of paths) {
        const value = mockValue(leafTypeAt(raw.schema as Record<string, unknown>, p), p, 0);
        setPath(data, p, value);
        setPath(nested, p, value);
      }
      data[raw.name] = nested;
    }
  }
  const parameters = (dsl as Record<string, unknown>).parameters;
  if (Array.isArray(parameters)) {
    for (const p of parameters as ParameterLike[]) {
      if (!p || typeof p !== 'object' || typeof p.name !== 'string') continue;
      data[p.name] = p.default !== undefined ? p.default : mockValue(p.type, p.name, 0);
    }
  }
  return data;
}
