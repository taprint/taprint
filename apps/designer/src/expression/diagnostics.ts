// SPDX-License-Identifier: Apache-2.0
// 表达式即时诊断（暂不支持）：对任意含 {{...}} 的原文逐个提取并经
// ExpressionCompiler.compile 编译，语法错误带原文偏移（monaco marker 定位用）。
// 与内核 expressionsOf 同正则口径（[^{}]+），纯函数 jsdom 可测。
import { ExpressionCompiler, ExpressionSyntaxError } from 'taprint';

export interface ExpressionDiagnostic {
  /** {{...}} 内表达式全文（trim 后） */
  expression: string;
  message: string;
  /** 表达式内字符偏移（ExpressionSyntaxError.position；-1 = 整段级错误如超限） */
  position: number;
  /** {{ 起始在原文中的偏移（含括号）；marker 起点 */
  startOffset: number;
  /** }} 结束后的偏移（exclusive）；marker 终点 */
  endOffset: number;
}

// 与内核 expressionsOf 同族正则，但用 * 而非 +：空 {{}} 内核不视为表达式，
// 编辑器侧须就近提示，故放宽匹配后单独判空。
const EXPR_RE = /\{\{([^{}]*)\}\}/g;

export function diagnoseExpressionValue(raw: string): ExpressionDiagnostic[] {
  if (typeof raw !== 'string' || !raw) return [];
  const out: ExpressionDiagnostic[] = [];
  for (const m of raw.matchAll(EXPR_RE)) {
    const ref = (m[1] ?? '').trim();
    const startOffset = m.index ?? 0;
    const endOffset = startOffset + m[0].length;
    if (!ref) {
      out.push({
        expression: '',
        message: '空表达式：{{}} 内须为合法表达式',
        position: 0,
        startOffset,
        endOffset,
      });
      continue;
    }
    try {
      ExpressionCompiler.compile(ref);
    } catch (e) {
      if (e instanceof ExpressionSyntaxError) {
        out.push({
          expression: ref,
          message: e.message,
          position: e.position,
          startOffset,
          endOffset,
        });
      } else {
        out.push({
          expression: ref,
          message: e instanceof Error ? e.message : String(e),
          position: -1,
          startOffset,
          endOffset,
        });
      }
    }
  }
  return out;
}
