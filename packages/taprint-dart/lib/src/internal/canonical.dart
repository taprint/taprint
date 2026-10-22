// SPDX-License-Identifier: Apache-2.0
// 规范化 JSON（canonical JSON）Dart 端：全深度递归 key 字典序 + JSON-safe 断言，
// 与 print-dsl-ts internal/canonical.ts / C# Internal/Canonical.cs 同构
//（v1.7 锁定规则； fixture 为多语言实现真值）。
// 数字一律经 formatEcmaNumber（ECMA-262 最短十进制）——fixture v4 锁定；禁止
// jsonEncode 直出数字（Dart jsonEncode(1.0) = "1.0"，与 JS Number 往返归一不符）。
// 字符串转义手写字面量（仅转义 " \ 与 U+0000-U+001F），与 JS JSON.stringify 逐字一致
//（含 U+3000/U+2028/U+2029 原样输出）。
// 循环检测按「当前路径上的祖先集合」回溯：DAG 形共享子对象（非循环）不误报，
// 真循环仍抛 ArgumentError。

import 'ecma_number.dart';

/// JSON-safe 断言（Dart 对象树）：仅允许 null/String/bool/num/Map/List；
/// 其余类型（DateTime/自定义对象等）与循环引用显式抛 ArgumentError。
void assertJsonSafe(Object? v, String path, [List<Object>? ancestors]) {
  if (v == null || v is String || v is bool || v is num) return;
  if (v is Map || v is List) {
    final stack = ancestors ?? <Object>[];
    for (final a in stack) {
      if (identical(a, v)) throw ArgumentError('循环引用位于 $path');
    }
    stack.add(v);
    if (v is List) {
      for (var i = 0; i < v.length; i++) {
        assertJsonSafe(v[i], '$path[$i]', stack);
      }
    } else {
      (v as Map).forEach((k, value) => assertJsonSafe(value, '$path.$k', stack));
    }
    stack.removeLast();
    return;
  }
  throw ArgumentError('非 JSON-safe 值（${v.runtimeType}）位于 $path');
}

/// JS JSON.stringify 字符串字面量（含双引号）：仅转义 " \ 和控制字符（U+0000-U+001F），
/// 非 ASCII 原样输出。按 UTF-16 code unit 逐位处理（与 JS 字符串索引一致，
/// 代理对原样透传）。
String jsonStringLiteral(String s) {
  final sb = StringBuffer('"');
  for (var i = 0; i < s.length; i++) {
    final c = s.codeUnitAt(i);
    switch (c) {
      case 0x5C:
        sb.write(r'\\');
      case 0x22:
        sb.write(r'\"');
      case 0x08:
        sb.write(r'\b');
      case 0x0C:
        sb.write(r'\f');
      case 0x0A:
        sb.write(r'\n');
      case 0x0D:
        sb.write(r'\r');
      case 0x09:
        sb.write(r'\t');
      default:
        if (c < 0x20) {
          sb.write('\\u${c.toRadixString(16).padLeft(4, '0')}');
        } else {
          sb.writeCharCode(c);
        }
    }
  }
  sb.write('"');
  return sb.toString();
}

/// 对象树 → canonical 紧凑串（先断言后写出；key 全深度字典序 = UTF-16 code unit 序，
/// 与 JS Array.sort()/C# Ordinal 同口径）。excludeSignature=true 时**仅顶层**剥离
/// signature（嵌套 signature 键一律保留——与 TS canonicalize 同口径，勿透传进递归）。
String canonicalizeTree(Object? v, {bool excludeSignature = false}) {
  assertJsonSafe(v, r'$');
  final sb = StringBuffer();
  _writeSorted(v, sb, excludeSignature);
  return sb.toString();
}

void _writeSorted(Object? v, StringBuffer sb, bool excludeSignature) {
  switch (v) {
    case null:
      sb.write('null');
    case final String s:
      sb.write(jsonStringLiteral(s));
    case final bool b:
      sb.write(b ? 'true' : 'false');
    case final num n:
      sb.write(formatEcmaNumber(n));
    case final List list:
      sb.write('[');
      for (var i = 0; i < list.length; i++) {
        if (i > 0) sb.write(',');
        _writeSorted(list[i], sb, false);
      }
      sb.write(']');
    case final Map map:
      sb.write('{');
      final keys = map.keys.map((k) => k as String).toList()..sort();
      var first = true;
      for (final k in keys) {
        if (excludeSignature && k == 'signature') continue;
        if (!first) sb.write(',');
        first = false;
        sb
          ..write(jsonStringLiteral(k))
          ..write(':');
        _writeSorted(map[k], sb, false);
      }
      sb.write('}');
    default:
      throw ArgumentError('非 JSON-safe 值（${v.runtimeType}）');
  }
}

/// key 排序的深拷贝（DslParser.stringify 与 TS sortKeysDeep 同构；canonical 写出
/// 自带排序，此处仅供需要排序树的场景复用）。
Object? sortKeysDeep(Object? v) {
  if (v is List) return v.map(sortKeysDeep).toList();
  if (v is Map) {
    final keys = v.keys.map((k) => k as String).toList()..sort();
    return {for (final k in keys) k: sortKeysDeep(v[k])};
  }
  return v;
}

/// JSON 数字归一深拷贝（SPEC ：镜像 JS JSON.parse——整数 JSON 数字归一 double；
/// Dart jsonDecode 对整数返回 int，parse/迁移入口统一经此归一）。
Object? normalizeJsonNumbers(Object? v) {
  if (v is int) return v.toDouble();
  if (v is List) return v.map(normalizeJsonNumbers).toList();
  if (v is Map) {
    return {
      for (final e in v.entries) e.key as String: normalizeJsonNumbers(e.value),
    };
  }
  return v;
}
