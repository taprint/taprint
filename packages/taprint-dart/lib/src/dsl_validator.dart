// SPDX-License-Identifier: Apache-2.0
// DSL 校验与字段字典 Dart 端（与 TS/C#/Java 同构）。
// - validate 的 JSON Schema 以参数注入（schema/v1.0.json 为仓库权威文件；内核不内置
//   文件路径，保证多语言实现可注入）——draft 2020-12，allErrors 全量报错；
// - validateBusiness 规则：表达式文法移交 ExpressionCompiler.compile（v1.41，主文档
//   ）+ 字段绑定存在性；解析顺序为数据源 → parameters → FieldRegistry（bizType =
//   dsl.code）兜底；错误码 bad-expression / unknown-field / ambiguous-field；
// - DSL 2.0 cross-path 规则：schema 只管单字段形状，跨字段结构
//   正确性在此校。错误码：header-cell-span-mismatch / subtotal-values-length /
//   static-row-span-mismatch / loop-each-not-detail / subtable-source-not-detail /
//   table-source-unknown。
import 'package:json_schema/json_schema.dart' as js;

import 'expression_compiler.dart';
import 'internal/analysis.dart';
import 'types.dart';

/// schema 编译缓存（Expando 按 Map 对象引用；与 TS WeakMap 同生命周期语义）。
final Expando<js.JsonSchema> _compileCache = Expando('dsl-schema-cache');

/// 单元格占位跨度（默认 1；非正整数视为 1，schema 层已校 ≥1）
int _positiveInt(Object? v) {
  if (v is int && v > 0) return v;
  if (v is double && v == v.truncateToDouble() && v > 0) return v.toInt();
  return 1;
}

/// 一行单元格 colspan 合计
int _spanSum(List row) => row.fold(
    0, (acc, c) => acc + _positiveInt(c is Map ? c['colspan'] : null));

class DslValidator {
  DslValidator._();

  /// JSON Schema 校验（draft 2020-12；allErrors 全量报错）。
  /// 错误映射 { path: instancePath||'\$', code: keyword }（keyword 取 schemaPath 末段，
  /// 与 Ajv keyword 同形态；文案不做逐字对齐，锚点锁 valid/path/code 三要素）。
  static ValidationResult validate(Map<String, Object?> dsl, Map<String, Object?> schema) {
    var compiled = _compileCache[schema];
    if (compiled == null) {
      compiled = js.JsonSchema.create(schema);
      _compileCache[schema] = compiled;
    }
    final results = compiled.validate(dsl);
    final errors = results.errors.map(_mapError).toList();
    return ValidationResult(valid: results.isValid, errors: errors);
  }

  /// 业务规则校验：表达式文法（ExpressionCompiler）+ 字段绑定存在性
  /// （数据源 → parameters → FieldRegistry 兜底）。fieldRegistry 显式传入时优先，
  /// 否则走全局 FieldRegistry（bizType = dsl.code）。
  static ValidationResult validateBusiness(
    Map<String, Object?> dsl, {
    Map<String, List<FieldDef>>? fieldRegistry,
  }) {
    final sources = dataSourcesOf(dsl);
    final params = paramNamesOf(dsl);
    final code = dsl['code'] is String ? dsl['code'] as String : '';
    final registered = (fieldRegistry != null
            ? fieldRegistry[code] ?? const <FieldDef>[]
            : FieldRegistry.lookup(code))
        .map((f) => f.code)
        .toSet();
    final errors = <ValidationError>[];
    for (final occ in expressionsOf(dsl)) {
      ExpressionAst ast;
      try {
        ast = ExpressionCompiler.compile(occ.ref);
      } on ExpressionSyntaxError catch (e) {
        errors.add(ValidationError(
          path: occ.path,
          code: 'bad-expression',
          message: '表达式不合法：${occ.raw}（${e.message}）',
        ));
        continue;
      }
      for (final ref in ExpressionCompiler.extractFields(ast)) {
        final verdict = classifyRef(ref, sources, params);
        if (verdict == RefVerdict.ambiguous) {
          errors.add(ValidationError(
            path: occ.path,
            code: 'ambiguous-field',
            message: '字段引用 $ref 在多个数据源中存在，须加源前缀消歧',
          ));
          continue;
        }
        if (verdict == RefVerdict.unknown && !registered.contains(ref)) {
          errors.add(ValidationError(
            path: occ.path,
            code: 'unknown-field',
            message: '表达式引用了未定义字段：$ref',
          ));
        }
      }
    }
    _validateV2Shapes(dsl, sources, errors);
    return ValidationResult(valid: errors.isEmpty, errors: errors);
  }

  // ---------- DSL 2.0 cross-path 规则 ----------

  /// doc 呈现内递归遍历流式元素，对 table/loop/subtable 做跨字段结构校验。
  static void _validateV2Shapes(
    Map<String, Object?> dsl,
    List<DataSourceInfo> sources,
    List<ValidationError> errors,
  ) {
    final presentations = dsl['presentations'];
    if (presentations is! Map) return;
    final doc = presentations['doc'];
    if (doc is! Map) return;
    for (final section in ['header', 'body', 'footer']) {
      final elems = doc[section];
      if (elems is List) {
        _walkFlowElements(elems, 'presentations.doc.$section', sources, errors);
      }
    }
  }

  static void _walkFlowElements(
    List elems,
    String basePath,
    List<DataSourceInfo> sources,
    List<ValidationError> errors,
  ) {
    for (var i = 0; i < elems.length; i++) {
      final raw = elems[i];
      if (raw is! Map) continue;
      final path = '$basePath[$i]';
      if (raw['type'] == 'table') {
        _validateTableShape(raw, path, sources, errors);
        continue;
      }
      if (raw['type'] == 'loop') {
        final each = raw['each'];
        if (each is String) {
          final src = sources.where((s) => s.name == each).firstOrNull;
          if (src == null || src.type != 'detail') {
            errors.add(ValidationError(
              path: '$path.each',
              code: 'loop-each-not-detail',
              message: 'loop.each "$each" 必须引用 type=detail 的数据源（行集合语义）',
            ));
          }
        }
        final body = raw['body'];
        if (body is List) {
          _walkFlowElements(body, '$path.body', sources, errors);
        }
        continue;
      }
      if (raw['type'] == 'conditional') {
        final body = raw['body'];
        if (body is List) {
          _walkFlowElements(body, '$path.body', sources, errors);
        }
        final elseBody = raw['elseBody'];
        if (elseBody is List) {
          _walkFlowElements(elseBody, '$path.elseBody', sources, errors);
        }
      }
    }
  }

  /// table 跨字段结构：表头网格 / 分组小计对齐 / 自由行宽 / 主从子表数据源。
  static void _validateTableShape(
    Map el,
    String path,
    List<DataSourceInfo> sources,
    List<ValidationError> errors,
  ) {
    // 引用完整性（二轮）：table.source 拼错不得拖到渲染期才暴露
    final source = el['source'];
    if (source is String && !sources.any((s) => s.name == source)) {
      errors.add(ValidationError(
        path: '$path.source',
        code: 'table-source-unknown',
        message: 'table.source "$source" 未定义于 dataSources',
      ));
    }

    final columns = el['columns'] is List ? el['columns'] as List : null;
    final headerRows = el['headerRows'] is List ? el['headerRows'] as List : null;

    int? width = columns?.length;
    if (width == null && headerRows != null && headerRows.isNotEmpty) {
      width = headerRows[0] is List ? _spanSum(headerRows[0] as List) : null;
    }

    if (headerRows != null && width != null && width > 0) {
      // 网格占位模拟：colspan/rowspan 越界/重叠/未填满均为渲染期错位，编译期即拒
      final w = width;
      final occupied = List.generate(
          headerRows.length, (_) => List<bool>.filled(w, false));
      for (var r = 0; r < headerRows.length; r++) {
        final row = headerRows[r];
        if (row is! List) continue;
        var c = 0;
        for (final cellRaw in row) {
          while (c < w && occupied[r][c]) {
            c++;
          }
          final cell = cellRaw is Map ? cellRaw : const {};
          final colspan = _positiveInt(cell['colspan']);
          final rowspan = _positiveInt(cell['rowspan']);
          final overflow = c + colspan > w || r + rowspan > headerRows.length;
          var collide = false;
          if (!overflow) {
            for (var rr = r; rr < r + rowspan && !collide; rr++) {
              for (var cc = c; cc < c + colspan; cc++) {
                if (occupied[rr][cc]) {
                  collide = true;
                  break;
                }
              }
            }
          }
          if (overflow || collide) {
            errors.add(ValidationError(
              path: '$path.headerRows[$r]',
              code: 'header-cell-span-mismatch',
              message:
                  '表头单元格（colspan=$colspan, rowspan=$rowspan）${overflow ? '超出表格边界' : '与其他单元格重叠'}（表头网格宽 $w 列 × ${headerRows.length} 行）',
            ));
          } else {
            for (var rr = r; rr < r + rowspan; rr++) {
              for (var cc = c; cc < c + colspan; cc++) {
                occupied[rr][cc] = true;
              }
            }
          }
          c += colspan;
        }
        if (!occupied[r].every((b) => b)) {
          errors.add(ValidationError(
            path: '$path.headerRows[$r]',
            code: 'header-cell-span-mismatch',
            message: '表头第 ${r + 1} 行未填满 $w 列（含上方 rowspan 占位）',
          ));
        }
      }
    }

    final groups = el['groups'] is List ? el['groups'] as List : const [];
    for (var gi = 0; gi < groups.length; gi++) {
      final g = groups[gi];
      if (g is! Map) continue;
      final subtotal = g['subtotal'];
      final values = subtotal is Map ? subtotal['values'] : null;
      if (width != null && values is List && values.length != width) {
        errors.add(ValidationError(
          path: '$path.groups[$gi].subtotal.values',
          code: 'subtotal-values-length',
          message: '分组小计 values 长度 ${values.length} ≠ 表格列数 $width（须逐列对齐，null 留空）',
        ));
      }
    }

    final staticRows = el['staticRows'];
    if (staticRows is Map && staticRows['rows'] is List) {
      final rows = staticRows['rows'] as List;
      for (var ri = 0; ri < rows.length; ri++) {
        final row = rows[ri];
        if (row is! List) continue;
        final span = _spanSum(row);
        if (width != null && span != width) {
          errors.add(ValidationError(
            path: '$path.staticRows.rows[$ri]',
            code: 'static-row-span-mismatch',
            message: 'staticRows 第 ${ri + 1} 行 colspan 合计 $span ≠ 表格列数 $width',
          ));
        }
        for (final cellRaw in row) {
          final rowspan = _positiveInt(cellRaw is Map ? cellRaw['rowspan'] : null);
          if (ri + rowspan > rows.length) {
            errors.add(ValidationError(
              path: '$path.staticRows.rows[$ri]',
              code: 'static-row-span-mismatch',
              message:
                  'staticRows 第 ${ri + 1} 行 rowspan=$rowspan 超出 staticRows 行数 ${rows.length}',
            ));
            break;
          }
        }
      }
    }

    if (columns != null) {
      for (var ci = 0; ci < columns.length; ci++) {
        final col = columns[ci];
        if (col is Map) {
          _validateSubtableSource(col, '$path.columns[$ci]', sources, errors);
        }
      }
    }
  }

  /// column.subtable.source 若指定，必须引用 type=detail 数据源（递归嵌套子表同校）。
  static void _validateSubtableSource(
    Map col,
    String path,
    List<DataSourceInfo> sources,
    List<ValidationError> errors,
  ) {
    final subtable = col['subtable'];
    if (subtable is! Map) return;
    final source = subtable['source'];
    if (source is String) {
      final src = sources.where((s) => s.name == source).firstOrNull;
      if (src == null || src.type != 'detail') {
        errors.add(ValidationError(
          path: '$path.subtable.source',
          code: 'subtable-source-not-detail',
          message: 'subtable.source "$source" 必须引用 type=detail 的数据源（主从行展开语义）',
        ));
      }
    }
    final subColumns = subtable['columns'];
    if (subColumns is List) {
      for (var ci = 0; ci < subColumns.length; ci++) {
        final c = subColumns[ci];
        if (c is Map) {
          _validateSubtableSource(c, '$path.subtable.columns[$ci]', sources, errors);
        }
      }
    }
  }

  static ValidationError _mapError(js.ValidationError e) {
    final instancePath = e.instancePath;
    final path = instancePath.isEmpty ? r'$' : instancePath;
    final segments = e.schemaPath.split('/');
    final keyword = segments.isNotEmpty ? segments.last : e.schemaPath;
    return ValidationError(path: path, code: keyword, message: '$path ${e.message}'.trim());
  }
}

/// 字段注册表（/：业务模块启动时注册，字段面板/校验查询）。
/// register 覆写该 bizType 的字段集；lookup 返回防御性拷贝。
class FieldRegistry {
  FieldRegistry._();

  static final Map<String, List<FieldDef>> _store = {};

  /// 注册字段（业务模块启动时调用；重复注册覆写）。
  static void register(String bizType, List<FieldDef> fields) {
    if (bizType.isEmpty) {
      throw ArgumentError.value(bizType, 'bizType', 'FieldRegistry.register: bizType 不能为空');
    }
    _store[bizType] = fields.map((f) => f.copy()).toList();
  }

  /// 查询字段（设计器字段面板用）；未注册的 bizType 返回空数组。
  static List<FieldDef> lookup(String bizType) =>
      (_store[bizType] ?? const []).map((f) => f.copy()).toList();

  /// 清空全部注册（测试隔离 / 宿主生命周期用）。
  static void clear() => _store.clear();
}
