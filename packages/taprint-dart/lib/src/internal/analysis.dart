// SPDX-License-Identifier: Apache-2.0
// DSL 静态分析 Dart 端（与 print-dsl-ts internal/analysis.ts 同构）：
// 数据源字段路径展平 + 表达式收集。DslParser.parseResult 与
// DslValidator.validateBusiness 共用。

/// 表达式出现位置：path 为 JSON path，raw 为完整 {{...}}，ref 为 {{}} 内表达式全文（trim 后）。
class ExpressionOccurrence {
  final String path;
  final String raw;
  final String ref;

  const ExpressionOccurrence({required this.path, required this.raw, required this.ref});
}

class DataSourceInfo {
  final String name;
  final String type;
  final Map<String, Object?> schema;

  const DataSourceInfo({required this.name, required this.type, required this.schema});
}

final _exprRe = RegExp(r'\{\{([^{}]+)\}\}');

List<DataSourceInfo> dataSourcesOf(Map<String, Object?> dsl) {
  final list = dsl['dataSources'];
  if (list is! List) return const [];
  final out = <DataSourceInfo>[];
  for (final ds in list) {
    if (ds is Map &&
        ds['name'] is String &&
        ds['schema'] is Map &&
        ds['schema'] != null) {
      out.add(DataSourceInfo(
        name: ds['name'] as String,
        type: ds['type'] is String ? ds['type'] as String : '',
        schema: (ds['schema'] as Map).cast<String, Object?>(),
      ));
    }
  }
  return out;
}

/// 展平字段字典为点路径（：叶子为类型名，嵌套对象为子结构）。
/// detail 源的路径带 `<name>[*].` 前缀（行集合语义，与  parse-result 示例一致）。
List<String> fieldPathsOf(Map<String, Object?> dsl) {
  final out = <String>{};
  for (final ds in dataSourcesOf(dsl)) {
    final prefix = ds.type == 'detail' ? '${ds.name}[*].' : '';
    _flattenSchema(ds.schema, prefix, out);
  }
  final sorted = out.toList()..sort();
  return sorted;
}

void _flattenSchema(Map<String, Object?> node, String prefix, Set<String> out) {
  node.forEach((key, value) {
    if (value is Map) {
      _flattenSchema(value.cast<String, Object?>(), '$prefix$key.', out);
    } else {
      out.add('$prefix$key');
    }
  });
}

/// 收集 presentations 内全部 {{...}} 表达式（parameters/dataSources 不在渲染面，不计）。
List<ExpressionOccurrence> expressionsOf(Map<String, Object?> dsl) {
  final out = <ExpressionOccurrence>[];
  _walk(dsl['presentations'], 'presentations', out);
  return out;
}

void _walk(Object? v, String path, List<ExpressionOccurrence> out) {
  if (v is String) {
    for (final m in _exprRe.allMatches(v)) {
      out.add(ExpressionOccurrence(path: path, raw: m.group(0)!, ref: m.group(1)!.trim()));
    }
    return;
  }
  if (v is List) {
    for (var i = 0; i < v.length; i++) {
      _walk(v[i], '$path[$i]', out);
    }
    return;
  }
  if (v is Map) {
    v.forEach((k, value) => _walk(value, '$path.$k', out));
  }
}

/// 顶层 parameters 名称集（主文档 ：运行时参数可被表达式引用，如 {{copies}}）。
Set<String> paramNamesOf(Map<String, Object?> dsl) {
  final list = dsl['parameters'];
  if (list is! List) return const {};
  return {
    for (final p in list)
      if (p is Map && p['name'] is String) p['name'] as String,
  };
}

/// 字段引用解析结论：ok=可解析；unknown=无处可解析；ambiguous=裸路径命中多个数据源。
enum RefVerdict { ok, unknown, ambiguous }

final _digitSegment = RegExp(r'^\d+$');

/// 字段引用可解析性（十轮：多源同名裸路径不再静默放行）：
/// 1) 首段为数据源名 → 余下路径须存在于该源 schema（单段即整源聚合引用）；
/// 2) 否则裸路径恰命中一个数据源 schema → ok（fixture 惯例：主源字段免前缀）；
/// 3) 裸路径命中 ≥2 个源 → ambiguous（要求写源前缀消歧）；
/// 4) 数据源均未命中 → 查 parameters 名称（运行时参数，如 copies/printer）。
/// 数组索引段（items.0.sku ⇔ items[0].sku，extractFields 输出形态）在校验前剥离。
RefVerdict classifyRef(String ref, List<DataSourceInfo> sources,
    [Set<String> paramNames = const {}]) {
  final normalized = ref
      .split('.')
      .where((seg) => !_digitSegment.hasMatch(seg))
      .join('.');
  if (normalized.isEmpty) return RefVerdict.unknown;
  final segments = normalized.split('.');
  final byName = sources.where((ds) => ds.name == segments.first).firstOrNull;
  if (byName != null) {
    if (segments.length == 1) return RefVerdict.ok;
    return _barePathsOf(byName.schema).contains(segments.sublist(1).join('.'))
        ? RefVerdict.ok
        : RefVerdict.unknown;
  }
  final matches =
      sources.where((ds) => _barePathsOf(ds.schema).contains(normalized)).length;
  if (matches == 1) return RefVerdict.ok;
  if (matches > 1) return RefVerdict.ambiguous;
  return paramNames.contains(normalized) ? RefVerdict.ok : RefVerdict.unknown;
}

Set<String> _barePathsOf(Map<String, Object?> schema) {
  final out = <String>{};
  _flattenSchema(schema, '', out);
  return out;
}
