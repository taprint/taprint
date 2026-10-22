// SPDX-License-Identifier: Apache-2.0
// 打印模板 DSL 核心类型（权威定义：schema/v1.0.json；schema/ 目录为权威定义）

/** 打印模板 DSL 顶层对象（完整字段以 schema/v1.0.json Phase 0 定稿为准） */
export interface TemplateDSL {
  schemaVersion: string;
  id: string;
  code: string;
  name: string;
  // ... 完整字段见 schema/v1.0.json（Phase 0 定稿）
  [key: string]: unknown;
}

/** 字段定义（字段面板 / FieldRegistry 用） */
export interface FieldDef {
  code: string;
  name: string;
  dataType: string;
  expression?: string;
}

/**
 * 表达式 AST 节点（判别联合；ExpressionCompiler.compile 产物）。
 * 语义口径：JS 表达式 + Liquid 管道，沙箱化求值；
 * 多语言实现（TS/C#/Dart）必须复现同结构（与 C#/Dart/Java 同构）。
 */
export type ExpressionNode =
  | { kind: 'literal'; value: number | string | boolean | null }
  /** 字段/变量引用：segments = 标识符与整数索引混排（items.0.sku ⇔ items[0].sku） */
  | { kind: 'path'; segments: Array<string | number> }
  | { kind: 'unary'; op: '-' | '!' | '+'; operand: ExpressionNode }
  | {
      kind: 'binary';
      op:
        | '||'
        | '&&'
        | '==='
        | '!=='
        | '=='
        | '!='
        | '<'
        | '<='
        | '>'
        | '>='
        | '+'
        | '-'
        | '*'
        | '/'
        | '%';
      left: ExpressionNode;
      right: ExpressionNode;
    }
  | { kind: 'ternary'; test: ExpressionNode; consequent: ExpressionNode; alternate: ExpressionNode }
  /** Liquid 过滤管道：value | name:arg1:arg2（参数为字面量） */
  | { kind: 'filter'; value: ExpressionNode; name: string; args: ExpressionNode[] }
  /** 自定义函数调用（now()/uuid()/tenantName() 等宿主函数；求值上下文注入） */
  | { kind: 'call'; name: string; args: ExpressionNode[] };

/** 表达式 AST（ExpressionCompiler 产物；与后端 QLExpress4 语义一致） */
export interface ExpressionAST {
  /** 原始表达式文本（不含 {{ }}） */
  raw: string;
  root: ExpressionNode;
}

export interface ValidationError {
  /** 错误位置（JSON path） */
  path: string;
  /** 错误码 */
  code: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}
