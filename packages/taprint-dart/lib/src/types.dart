// SPDX-License-Identifier: Apache-2.0
// 打印模板 DSL 核心类型 Dart 端（PRINT-DSL-DART-API-SPEC ；权威定义 schema/v1.0.json）。

/// 字段定义（字段面板 / FieldRegistry 用）。
class FieldDef {
  final String code;
  final String name;
  final String dataType;
  final String? expression;

  const FieldDef({
    required this.code,
    required this.name,
    required this.dataType,
    this.expression,
  });

  FieldDef copy() =>
      FieldDef(code: code, name: name, dataType: dataType, expression: expression);

  @override
  bool operator ==(Object other) =>
      other is FieldDef &&
      other.code == code &&
      other.name == name &&
      other.dataType == dataType &&
      other.expression == expression;

  @override
  int get hashCode => Object.hash(code, name, dataType, expression);

  @override
  String toString() => 'FieldDef($code, $name, $dataType)';
}

///  parse-result 期望输出形状。
class ParseResult {
  /// sha256:<64 hex>
  final String hash;

  /// 字典序去重；detail 源 `<name>[*].` 前缀。
  final List<String> fieldPaths;

  /// 仅 presentations 内 {{...}} 计数。
  final int expressionCount;

  final bool valid;

  const ParseResult({
    required this.hash,
    required this.fieldPaths,
    required this.expressionCount,
    required this.valid,
  });

  /// 与 expected-output JSON 逐字比对用的 Map 形态（key 顺序无关，测试用深度相等）。
  Map<String, Object?> toJsonMap() => {
        'hash': hash,
        'fieldPaths': fieldPaths,
        'expressionCount': expressionCount,
        'valid': valid,
      };
}

/// 校验错误（path = JSON path；code = 错误码）。
class ValidationError {
  final String path;
  final String code;
  final String message;

  const ValidationError({required this.path, required this.code, required this.message});

  @override
  String toString() => '$path [$code] $message';
}

class ValidationResult {
  final bool valid;
  final List<ValidationError> errors;

  const ValidationResult({required this.valid, required this.errors});
}

/// 表达式 AST 节点（判别联合 7 kind；TS ExpressionNode / C# sealed record 同构）。
sealed class ExpressionNode {
  const ExpressionNode();
}

class LiteralNode extends ExpressionNode {
  /// double | String | bool | null
  final Object? value;

  const LiteralNode(this.value);
}

/// 字段/变量引用：segments = String 与 int（非负整数索引）混排（items.0.sku ⇔ items[0].sku）。
class PathNode extends ExpressionNode {
  final List<Object> segments;

  const PathNode(this.segments);
}

class UnaryNode extends ExpressionNode {
  /// '-' | '!' | '+'
  final String op;
  final ExpressionNode operand;

  const UnaryNode(this.op, this.operand);
}

class BinaryNode extends ExpressionNode {
  final String op;
  final ExpressionNode left;
  final ExpressionNode right;

  const BinaryNode(this.op, this.left, this.right);
}

class TernaryNode extends ExpressionNode {
  final ExpressionNode test;
  final ExpressionNode consequent;
  final ExpressionNode alternate;

  const TernaryNode(this.test, this.consequent, this.alternate);
}

/// Liquid 过滤管道：value | name:arg1:arg2（参数为字面量）。
class FilterNode extends ExpressionNode {
  final ExpressionNode value;
  final String name;
  final List<ExpressionNode> args;

  const FilterNode(this.value, this.name, this.args);
}

/// 自定义函数调用（now()/uuid()/tenantName() 等，；求值上下文注入）。
class CallNode extends ExpressionNode {
  final String name;
  final List<ExpressionNode> args;

  const CallNode(this.name, this.args);
}

/// 表达式 AST（ExpressionCompiler.compile 产物）。
class ExpressionAst {
  /// 原始表达式文本（不含 {{ }}）。
  final String raw;
  final ExpressionNode root;

  const ExpressionAst(this.raw, this.root);
}

/// JS `undefined` 显式哨兵（SPEC ；等价 C# JsUndefined 单例）：
/// 路径缺失/聚合跳过/拼接缺省语义贯通。消费方不得以 `== null` 判缺失。
class JsUndefined {
  const JsUndefined._();

  static const JsUndefined value = JsUndefined._();

  @override
  String toString() => 'undefined';
}
