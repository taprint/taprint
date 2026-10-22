// SPDX-License-Identifier: Apache-2.0
// 模板字符串求值：{{...}} 与字面量混排，逐段用 taprint 内核 ExpressionCompiler
// 求值后拼接。语义与 apps/mcp 的 template-string.ts 同口径（主数据源展平 +
// 参数缺省 + data 覆盖）；此处独立实现是因为 taprint-preview 不依赖 MCP 应用层，
// 只依赖内核包（ADR-0008 纯 JS 白名单之外仅允许 workspace 内核）。
import { ExpressionCompiler } from 'taprint';

const EXPR_RE = /\{\{([^{}]+)\}\}/g;

export type Json = Record<string, unknown>;

/**
 * 求值作用域组装：{ ...参数缺省值, ...主数据源字段展平, ...data }（后者优先）。
 * 表达式文法按裸字段引用（`{{billNo}}`、`{{store.name}}`），而 data 按数据源
 * 分组（{ main: {...}, items: [...] }）——primary 源字段展平到顶层，同时保留
 * 各源原名（detail 源供 table 按名取行集）。
 */
export function buildScope(template: Json, data: Json): Json {
  const scope: Json = {};
  const params = template.parameters;
  if (Array.isArray(params)) {
    for (const p of params) {
      if (p && typeof p === 'object' && typeof (p as Json).name === 'string') {
        const entry = p as Json;
        if ('default' in entry) scope[entry.name as string] = entry.default;
      }
    }
  }
  const sources = template.dataSources;
  if (Array.isArray(sources)) {
    const primary = sources.find((s) => (s as Json)?.type === 'primary') as Json | undefined;
    const primaryData = primary && typeof primary.name === 'string' ? data[primary.name] : undefined;
    if (primaryData && typeof primaryData === 'object') Object.assign(scope, primaryData);
  }
  return { ...scope, ...data };
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 模板串 → 渲染串（表达式求值失败显式上抛，不静默吞错）。 */
export function renderTemplateString(tpl: string, scope: Json): string {
  return tpl.replace(EXPR_RE, (_all, ref: string) => {
    const ast = ExpressionCompiler.compile(ref.trim());
    return stringify(ExpressionCompiler.evaluate(ast, scope, 1000));
  });
}

/** 渲染错误：渲染管线显式失败（缺呈现/缺字段/非法码制），不静默降级。 */
export class RenderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
  }
}
