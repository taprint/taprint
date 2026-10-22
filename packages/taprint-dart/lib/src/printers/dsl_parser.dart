// SPDX-License-Identifier: Apache-2.0
// 收据（receipt）呈现 DSL 子集解析——ESC/POS 编码器的数据入口。
//
// 解析范围：presentations.receipt 子树的最小集合——
// text/kvtable/table/line/cut/qrcode/barcode/cashDrawer 元素；
// width/encoding/initCommands/tailCommands 字段。
// 注意：本文件与内核 src/dsl_parser.dart（全量 DSL 对象树解析）同名
// 不同物；本解析器只服务字节编码器，schema 校验/迁移不在其职责内。
//
// 未知元素类型按 ESC/POS 兜底口径处理：编码为空行（不抛错，
// 降级决策归调用方）。

import 'dart:convert';

/// 收据呈现模板（presentations.receipt 解析产物）。
class DslTemplate {
  const DslTemplate({
    required this.id,
    required this.version,
    this.encoding = 'gbk',
    this.width = '80mm',
    this.initCommands = const [],
    this.tailCommands = const [],
    required this.body,
  });

  final String id;
  final String version;
  final String encoding;
  final String width;
  final List<String> initCommands;
  final List<String> tailCommands;
  final List<DslElement> body;
}

/// receipt body 元素（按 type 分发）。
class DslElement {
  const DslElement({
    required this.type,
    this.content,
    this.align,
    this.style = const {},
    this.rows = const [],
    this.columns = 1,
    this.source,
    this.columnSpecs = const [],
    this.partial = true,
    this.symbology = 'CODE128',
    this.text,
    this.size = 6,
  });

  final String type;
  final String? content;
  final String? align;
  final Map<String, dynamic> style;
  final List<List<List<String>>> rows; // kvtable rows: 行 → 列 → [k, v]
  final int columns;
  final String? source; // table 数据源名
  final List<DslColumnSpec> columnSpecs;
  final bool partial; // cut partial
  final String? symbology; // barcode
  final String? text; // barcode/qrcode 内容（alias）
  final int? size; // qrcode size 1-16
}

class DslColumnSpec {
  const DslColumnSpec({
    required this.header,
    required this.field,
    this.width,
    this.align,
  });

  final String header;
  final String field;
  final String? width; // "45%" / null
  final String? align;
}

class DslParser {
  const DslParser._();

  /// 解析 DSL JSON（fixture 形态：顶层 schemaVersion/id/presentations）。
  /// 仅取 presentations.receipt 子树；其他呈现（doc/label）不在本解析器
  /// 范围（label 呈现走 label_layout.dart 的 LabelLayoutParser）。
  static DslTemplate parse(String json, {String version = '1'}) {
    final dynamic root = jsonDecode(json);
    if (root is! Map) {
      throw const FormatException('DSL 根必须为对象');
    }
    final id = (root['id'] as String?) ?? 'unknown';
    final presentations = root['presentations'];
    if (presentations is! Map || presentations['receipt'] is! Map) {
      throw const FormatException('DSL 缺 presentations.receipt 节');
    }
    final receipt = presentations['receipt'] as Map<String, dynamic>;
    final bodyRaw = receipt['body'];
    if (bodyRaw is! List) {
      throw const FormatException('DSL receipt.body 必须为数组');
    }
    final body = <DslElement>[];
    for (final e in bodyRaw) {
      body.add(_parseElement(e as Map<String, dynamic>));
    }
    return DslTemplate(
      id: id,
      version: version,
      encoding: (receipt['encoding'] as String?) ?? 'gbk',
      width: (receipt['width'] as String?) ?? '80mm',
      initCommands: _toStringList(receipt['initCommands']),
      tailCommands: _toStringList(receipt['tailCommands']),
      body: body,
    );
  }

  static DslElement _parseElement(Map<String, dynamic> raw) {
    final type = (raw['type'] as String?) ?? 'unknown';
    final styleRaw = raw['style'];
    final style = styleRaw is Map
        ? Map<String, dynamic>.from(styleRaw)
        : const <String, dynamic>{};
    var cols = const <DslColumnSpec>[];
    if (raw['columns'] is List) {
      final list = <DslColumnSpec>[];
      for (final c in raw['columns'] as List) {
        list.add(_parseColumnSpec(c as Map<String, dynamic>));
      }
      cols = list;
    }
    var rows = const <List<List<String>>>[];
    if (raw['rows'] is List) {
      rows = _parseKvRows(raw['rows'] as List);
    }
    return DslElement(
      type: type,
      content: raw['content'] as String?,
      align: raw['align'] as String?,
      style: style,
      rows: rows,
      columns: raw['columns'] is int ? (raw['columns'] as int) : 1,
      source: raw['source'] as String?,
      columnSpecs: cols,
      partial: (raw['partial'] as bool?) ?? true,
      symbology: (raw['symbology'] as String?) ?? 'CODE128',
      text: raw['text'] as String? ?? raw['content'] as String?,
      size: (raw['size'] as int?) ?? 6,
    );
  }

  static DslColumnSpec _parseColumnSpec(Map<String, dynamic> raw) {
    return DslColumnSpec(
      header: (raw['header'] as String?) ?? '',
      field: (raw['field'] as String?) ?? '',
      width: raw['width'] as String?,
      align: raw['align'] as String?,
    );
  }

  /// kvtable.rows 形态：`[ Row, Row, ... ]`，Row=`[ Col, Col, ... ]`，
  /// Col=`[k, v]`（数组形态，元素为字符串）。
  static List<List<List<String>>> _parseKvRows(List raw) {
    final rowsOut = <List<List<String>>>[];
    for (final row in raw) {
      if (row is! List) {
        rowsOut.add(const []);
        continue;
      }
      final colsOut = <List<String>>[];
      for (final col in row) {
        if (col is! List) {
          colsOut.add(const ['', '']);
          continue;
        }
        colsOut.add([
          col.isNotEmpty ? (col[0]?.toString() ?? '') : '',
          col.length > 1 ? (col[1]?.toString() ?? '') : '',
        ]);
      }
      rowsOut.add(colsOut);
    }
    return rowsOut;
  }

  static List<String> _toStringList(dynamic raw) {
    if (raw is! List) return const [];
    final out = <String>[];
    for (final e in raw) {
      out.add(e.toString());
    }
    return out;
  }
}
