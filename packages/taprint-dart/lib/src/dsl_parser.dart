// SPDX-License-Identifier: Apache-2.0
// DSL 解析/序列化/内容 hash Dart 端（与 TS/C#/Java 同构）。
// 规范化口径（多语言实现一致，fixture 锁定）：
// - stringify：全深度递归 key 字典序 + 紧凑 JSON（与 MessageSigner.canonicalize 同规则，
//   但不剥离 signature——DSL 无签名字段语义）；数字经 formatEcmaNumber 唯一出口；
// - hash：sha256:<hex>，摘要输入为 stringify 输出 UTF-8 字节（ parse-result 的 hash 形态）；
// - parseResult： expected-output 四字段（hash/fieldPaths/expressionCount/valid），
//   expressionCount 仅统计 presentations（渲染面），detail 路径带 <name>[*]. 前缀。
// 数字归一（SPEC ）：Dart jsonDecode 对整数 JSON 数字返回 int，parse 入口深归一
// double（镜像 JS JSON.parse），保证 stringify/hash 与 TS/C# 逐字一致。

import 'dart:convert';

import 'dsl_validator.dart';
import 'internal/analysis.dart';
import 'internal/canonical.dart';
import 'internal/crypto.dart';
import 'types.dart';

class DslParser {
  DslParser._();

  /// 解析 JSON 字符串为 DSL 对象树（容忍 BOM；顶层必须为对象；schema 合法性归
  /// DslValidator）。非法 JSON 抛 FormatException；顶层非对象抛 ArgumentError。
  static Map<String, Object?> parse(String json) {
    final text =
        json.isNotEmpty && json.codeUnitAt(0) == 0xFEFF ? json.substring(1) : json;
    final Object? value;
    try {
      value = jsonDecode(text);
    } on FormatException catch (e) {
      throw FormatException('DslParser.parse: 非法 JSON —— ${e.message}');
    }
    if (value is! Map) {
      throw ArgumentError('DslParser.parse: 顶层必须为 JSON 对象');
    }
    return (normalizeJsonNumbers(value) as Map).cast<String, Object?>();
  }

  /// 序列化 DSL 为 JSON 字符串（规范化：key 字典序 + 紧凑，便于 hash/比较）。
  /// 非 JSON-safe 值/循环引用抛 ArgumentError。
  static String stringify(Map<String, Object?> dsl) => canonicalizeTree(dsl);

  /// 计算 DSL 内容 hash（用于版本检测、缓存）：sha256:<hex>(stringify 输出)。
  static String hash(Map<String, Object?> dsl) =>
      'sha256:${toHex(sha256Bytes(utf8Bytes(DslParser.stringify(dsl))))}';

  ///  parse-result：schema 为 JSON Schema 权威定义（schema/v1.0.json），供 valid 判定。
  static ParseResult parseResult(Map<String, Object?> dsl, Map<String, Object?> schema) =>
      ParseResult(
        hash: DslParser.hash(dsl),
        fieldPaths: fieldPathsOf(dsl),
        expressionCount: expressionsOf(dsl).length,
        valid: DslValidator.validate(dsl, schema).valid,
      );
}
