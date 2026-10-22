// SPDX-License-Identifier: Apache-2.0
// 模板字符串渲染：{{...}} 与字面量混排 → 逐段用内核 ExpressionCompiler
// 求值后拼接（作用域 = 参数缺省值 ← 数据字段覆盖；自定义宿主函数按
// ADR-0007 以函数值注入 data——MCP 工具入参只收 JSON，无法注入函数，
// 含 call 的模板请在宿主程序内渲染，本层求值会显式抛错）。
import { ExpressionCompiler } from 'taprint';
import { ToolError } from './errors.ts';

const EXPR_RE = /\{\{([^{}]+)\}\}/g;

/**
 * 求值作用域组装：{ ...参数缺省值, ...主数据源字段展平, ...data }（后者优先）。
 * 表达式文法按裸字段引用（`{{billNo}}`、`{{store.name}}`），而 data 按数据源
 * 分组（{ main: {...}, items: [...] }）——把 primary 源字段展平到顶层，同时
 * 保留各源原名（detail 源供 table/loop 按名取行集）。
 */
export function buildScope(template: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  const params = template.parameters;
  if (Array.isArray(params)) {
    for (const p of params) {
      if (p && typeof p === 'object' && typeof (p as Record<string, unknown>).name === 'string') {
        const entry = p as Record<string, unknown>;
        if ('default' in entry) scope[entry.name as string] = entry.default;
      }
    }
  }
  const sources = template.dataSources;
  if (Array.isArray(sources)) {
    const primary = sources.find(
      (s) => (s as Record<string, unknown>)?.type === 'primary',
    ) as Record<string, unknown> | undefined;
    const primaryData = primary && typeof primary.name === 'string' ? data[primary.name] : undefined;
    if (primaryData && typeof primaryData === 'object') Object.assign(scope, primaryData);
  }
  return { ...scope, ...data };
}

/** 求值结果 → 字符串（null/undefined 归空串；其余走 String()）。 */
function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 模板串 → 渲染串（求值失败/沙箱超时显式上抛，不静默吞表达式）。 */
export function renderTemplateString(tpl: string, scope: Record<string, unknown>): string {
  return tpl.replace(EXPR_RE, (_all, ref: string) => {
    try {
      const ast = ExpressionCompiler.compile(ref.trim());
      return stringify(ExpressionCompiler.evaluate(ast, scope, 1000));
    } catch (e) {
      throw new ToolError(
        'expression-error',
        `表达式 {{${String(ref).trim()}}} 求值失败：${(e as Error).message}`,
      );
    }
  });
}
