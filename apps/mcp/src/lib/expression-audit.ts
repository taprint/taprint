// SPDX-License-Identifier: Apache-2.0
// 表达式静态扫描：模板内 {{...}} 出现位置收集 + 宿主函数审计（最小版
// ExpressionAudit）。内核 internal/analysis 不对外导出，MCP 层自带一份轻量
// 遍历（只认字符串值里的 {{...}}，与内核 EXPR_RE 同文法）。
import { ExpressionCompiler } from 'taprint';
import type { ExpressionNode } from 'taprint';

/** 表达式出现位置：path 为 JSON path，raw 为完整 {{...}}，ref 为花括号内表达式。 */
export interface ExpressionOccurrence {
  path: string;
  raw: string;
  ref: string;
}

const EXPR_RE = /\{\{([^{}]+)\}\}/g;

/** 递归遍历模板 JSON，收集所有字符串值里的 {{...}} 表达式及其 JSON path。 */
export function collectExpressions(
  node: unknown,
  path = '$',
  out: ExpressionOccurrence[] = [],
): ExpressionOccurrence[] {
  if (typeof node === 'string') {
    for (const m of node.matchAll(EXPR_RE)) {
      out.push({ path, raw: m[0], ref: m[1].trim() });
    }
  } else if (Array.isArray(node)) {
    node.forEach((item, i) => collectExpressions(item, `${path}[${i}]`, out));
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      collectExpressions(value, `${path}.${key}`, out);
    }
  }
  return out;
}

/** 走 AST 收集函数名：call 节点（宿主函数）与 filter 节点（内置过滤器）。 */
export function functionNamesOf(root: ExpressionNode): { calls: string[]; filters: string[] } {
  const calls = new Set<string>();
  const filters = new Set<string>();
  const walk = (node: ExpressionNode): void => {
    switch (node.kind) {
      case 'unary':
        walk(node.operand);
        break;
      case 'binary':
        walk(node.left);
        walk(node.right);
        break;
      case 'ternary':
        walk(node.test);
        walk(node.consequent);
        walk(node.alternate);
        break;
      case 'filter':
        filters.add(node.name);
        walk(node.value);
        for (const a of node.args) walk(a);
        break;
      case 'call':
        calls.add(node.name);
        for (const a of node.args) walk(a);
        break;
      default:
        break;
    }
  };
  walk(root);
  return { calls: [...calls], filters: [...filters] };
}

export interface AuditError {
  path: string;
  code: string;
  message: string;
}

/**
 * 宿主函数审计（ADR-0007 SPI 的静态面）：表达式里的 call 名单必须落在
 * hostFunctions 白名单内，未注册即报 unknown-host-function（未注册函数
 * 只会在求值期炸，静态先拦——Java 端 ExpressionAudit 同概念的最小版）。
 * 文法非法的表达式跳过（validateBusiness 已按 bad-expression 报过）。
 */
export function auditHostFunctions(
  template: unknown,
  hostFunctions: readonly string[],
): AuditError[] {
  const allowed = new Set(hostFunctions);
  const errors: AuditError[] = [];
  for (const occ of collectExpressions(template)) {
    let ast;
    try {
      ast = ExpressionCompiler.compile(occ.ref);
    } catch {
      continue; // 文法错由 validateBusiness 的 bad-expression 覆盖
    }
    const { calls } = functionNamesOf(ast.root);
    for (const name of calls) {
      if (!allowed.has(name)) {
        errors.push({
          path: occ.path,
          code: 'unknown-host-function',
          message: `表达式 ${occ.raw} 调用了未注册宿主函数 ${name}()；请在入参 hostFunctions 中登记，或改用数据字段/内置过滤器`,
        });
      }
    }
  }
  return errors;
}
