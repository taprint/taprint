// SPDX-License-Identifier: Apache-2.0
// 预览求值层（M2 预览仿真块 A）：{{...}} 插值与 when 条件求值，全部经内核
// ExpressionCompiler 沙箱（白名单文法 + 50ms 超时），设计态容错——编译/求值失败
// 保留原文（插值）或兜底 true（when），不向用户抛错（近似预览边界）。
import { ExpressionCompiler } from 'taprint';

const EXPR_RE = /\{\{([^{}]+)\}\}/g;
const EVAL_TIMEOUT_MS = 50;

function tryEvaluate(expr: string, data: Record<string, unknown>): { ok: boolean; value: unknown } {
  try {
    const ast = ExpressionCompiler.compile(expr);
    return { ok: true, value: ExpressionCompiler.evaluate(ast, data, EVAL_TIMEOUT_MS) };
  } catch {
    return { ok: false, value: undefined };
  }
}

/** 原文中每个 {{...}} 求值并插回；失败原样保留（设计态容错） */
export function evaluateInterpolated(raw: string, data: Record<string, unknown>): string {
  if (typeof raw !== 'string' || !raw) return '';
  return raw.replace(EXPR_RE, (whole, ref: string) => {
    const r = tryEvaluate(ref.trim(), data);
    if (!r.ok) return whole;
    return r.value === null || r.value === undefined ? '' : String(r.value);
  });
}

/**
 * when 条件求值（设计契约）：先把 `{{ref}}` 替换为求值字面量
 * （JSON.stringify），再整段经内核 compile+evaluate 走沙箱——形如
 * `{{paidAmount}} < {{totalAmount}}` 替换后即合法表达式。任意环节失败兜底 true。
 *
 * 边界登记（评审观察项）：JSON.stringify 对含 \b \f \v 等控制字符的真实数据会
 * 产出内核字符串转义白名单（\n \t \r \\ \' \"）之外的转义 → 编译失败走兜底 true。
 * mock 数据永不触发；兜底 true 即声明口径，宿主 接真实数据时留意。
 */
export function evaluateWhen(when: string, data: Record<string, unknown>): boolean {
  if (typeof when !== 'string' || !when.trim()) return true;
  const substituted = when.replace(EXPR_RE, (_whole, ref: string) => {
    const r = tryEvaluate(ref.trim(), data);
    if (!r.ok || r.value === undefined) return 'null';
    return JSON.stringify(r.value) ?? 'null';
  });
  const r = tryEvaluate(substituted, data);
  if (!r.ok) return true;
  return Boolean(r.value);
}
