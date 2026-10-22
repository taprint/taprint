// SPDX-License-Identifier: Apache-2.0
// ESC/POS 字节编码器（收据方言，共享内核 escpos 子集）。
//
// 口径（与 Java/TS 参考实现 EscPosRenderer 同构，golden 字节锁定的
// 跨语言契约，ADR-0009）：
// - 初始化 ESC @ / 知名命令映射（initCommands/tailCommands 白名单：
//   ESC @、GS V 0/1）；
// - 对齐 ESC a n、字号 GS ! n、粗体 ESC E n；
// - 文本走 [GbkEncoder] 编码（默认 GB18030 双字节区全表通道）；
// - QR 原生 GS ( k 五步序列（与参考实现 writeQrCodeNative 逐字节一致）；
// - 切纸 GS V n（n=1 半切 / 0 全切）；
// - 表格列宽分配按百分比 + 未指定列均分剩余。

import 'dart:typed_data';

import 'dsl_parser.dart';
import 'expression_compiler.dart';
import 'gbk_codec.dart';

class EscPosEncoder {
  EscPosEncoder({this.widthCols = 32, GbkEncoder? gbk})
      : gbk = gbk ?? const GbkFullCodec();

  final int widthCols;
  final GbkEncoder gbk;

  static const _init = [0x1B, 0x40];
  static const _lf = [0x0A];
  static const _kanjiModeOn = [0x1C, 0x26];

  /// 编码模板为字节流（接收已求值的 primary 数据 + 明细数据）。
  Uint8List encode(
    DslTemplate template,
    Map<String, dynamic> primary, {
    Map<String, List<Map<String, dynamic>>> details = const {},
  }) {
    final out = <int>[];
    out.addAll(_init);
    out.addAll(_mapInitCommands(template.initCommands));
    if (gbk.isGbkLike) out.addAll(_kanjiModeOn);
    for (final el in template.body) {
      _encodeElement(out, el, primary, details);
    }
    out.addAll(_mapTailCommands(template.tailCommands));
    return Uint8List.fromList(out);
  }

  void _encodeElement(
    List<int> out,
    DslElement el,
    Map<String, dynamic> primary,
    Map<String, List<Map<String, dynamic>>> details,
  ) {
    switch (el.type) {
      case 'text':
        _encodeText(out, el, primary);
        break;
      case 'kvtable':
        _encodeKvTable(out, el, primary);
        break;
      case 'table':
        _encodeTable(out, el, details);
        break;
      case 'line':
        _writeAlign(out, 'left');
        out.addAll(gbk.encode(_separator(widthCols)));
        out.addAll(_lf);
        break;
      case 'cut':
        _writeCut(out, el);
        break;
      case 'qrcode':
        _encodeQrcode(out, el, primary);
        break;
      case 'barcode':
        // barcode 不在 escpos 子集最小范围；按参考实现的「未知元素
        // fallback 空行」口径。
        out.addAll(_lf);
        break;
      case 'cashDrawer':
        _writeCashDrawer(out, el);
        break;
      default:
        out.addAll(_lf);
    }
  }

  // ---- text ----

  void _encodeText(List<int> out, DslElement el, Map<String, dynamic> primary) {
    final text = ExpressionCompiler.interpolate(
      el.content ?? '',
      primary,
    );
    _writeAlign(out, el.align ?? 'left');
    final fontSize = (el.style['fontSize'] ?? 'normal').toString();
    out.addAll([0x1D, 0x21, _mapFontSize(fontSize)]);
    final bold = el.style['bold'] == true;
    out.addAll([0x1B, 0x45, bold ? 0x01 : 0x00]);
    for (final line in text.split('\n')) {
      out.addAll(gbk.encode(line));
      out.addAll(_lf);
    }
    out.addAll([0x1D, 0x21, 0x00]);
    out.addAll([0x1B, 0x45, 0x00]);
  }

  int _mapFontSize(String name) {
    switch (name) {
      case 'tall':
        return 0x01;
      case 'wide':
        return 0x10;
      case 'double':
        return ((2 - 1) << 4) | (2 - 1);
      case 'triple':
        return ((3 - 1) << 4) | (3 - 1);
      case 'quadruple':
        return ((4 - 1) << 4) | (4 - 1);
      default:
        return 0x00;
    }
  }

  // ---- kvtable ----

  void _encodeKvTable(List<int> out, DslElement el, Map<String, dynamic> primary) {
    _writeAlign(out, 'left');
    final cols = el.columns < 1 ? 1 : el.columns;
    final pairWidth = widthCols ~/ cols;
    for (final row in el.rows) {
      if (row.isEmpty) {
        out.addAll(_lf);
        continue;
      }
      final buf = StringBuffer();
      if (cols == 1) {
        final k = ExpressionCompiler.interpolate(row.first[0], primary);
        final v = ExpressionCompiler.interpolate(row.first[1], primary);
        if (_displayWidth(k) + _displayWidth(v) + 1 <= widthCols) {
          buf.write(_padLeft(k, widthCols - _displayWidth(v)));
          buf.write(v);
        } else {
          buf.write('$k:$v');
        }
      } else {
        for (final col in row) {
          final k = ExpressionCompiler.interpolate(col[0], primary);
          final v = ExpressionCompiler.interpolate(col[1], primary);
          buf.write(_padLeft('$k:$v', pairWidth));
        }
      }
      out.addAll(gbk.encode(_truncate(buf.toString(), widthCols)));
      out.addAll(_lf);
    }
  }

  // ---- table ----

  void _encodeTable(
    List<int> out,
    DslElement el,
    Map<String, List<Map<String, dynamic>>> details,
  ) {
    if (el.columnSpecs.isEmpty) return;
    final widths = _computeColumnWidths(el.columnSpecs, widthCols);
    _writeAlign(out, 'left');
    // 表头
    final header = StringBuffer();
    for (var i = 0; i < el.columnSpecs.length; i++) {
      header.write(_pad(el.columnSpecs[i].header, widths[i],
          el.columnSpecs[i].align ?? 'left'));
    }
    out.addAll(gbk.encode(header.toString()));
    out.addAll(_lf);
    out.addAll(gbk.encode(_separator(widthCols)));
    out.addAll(_lf);
    // 数据行
    final source = el.source ?? '';
    final rows = details[source] ?? const [];
    for (final row in rows) {
      final line = StringBuffer();
      for (var i = 0; i < el.columnSpecs.length; i++) {
        final spec = el.columnSpecs[i];
        final raw = row[spec.field];
        final cell = raw?.toString() ?? '';
        line.write(_pad(cell, widths[i], spec.align ?? 'left'));
      }
      out.addAll(gbk.encode(line.toString()));
      out.addAll(_lf);
    }
  }

  /// 列宽分配：百分比列按比例，其余均分剩余（参考实现
  /// computeColumnWidths 同构口径）。
  List<int> _computeColumnWidths(List<DslColumnSpec> cols, int widthCols) {
    final widths = List<int>.filled(cols.length, 0);
    var unspecified = 0;
    for (final c in cols) {
      final w = c.width;
      if (w == null || !_isPercent(w)) {
        unspecified++;
      }
    }
    var used = 0;
    for (var i = 0; i < cols.length; i++) {
      final w = cols[i].width;
      if (w != null && _isPercent(w)) {
        widths[i] = (widthCols * _parsePercent(w) / 100).round();
        if (widths[i] < 1) widths[i] = 1;
        used += widths[i];
      }
    }
    if (unspecified > 0) {
      final remain = widthCols - used < unspecified
          ? unspecified
          : widthCols - used;
      final each = remain ~/ unspecified;
      var extra = remain - each * unspecified;
      for (var i = 0; i < cols.length; i++) {
        final w = cols[i].width;
        if (w == null || !_isPercent(w)) {
          widths[i] = each + (extra > 0 ? 1 : 0);
          if (extra > 0) extra--;
        }
      }
    }
    return widths;
  }

  bool _isPercent(String s) => s.endsWith('%');

  int _parsePercent(String s) {
    final n = num.tryParse(s.substring(0, s.length - 1));
    return n?.toInt() ?? 0;
  }

  // ---- qrcode ----

  void _encodeQrcode(
    List<int> out,
    DslElement el,
    Map<String, dynamic> primary,
  ) {
    final content = ExpressionCompiler.interpolate(el.text ?? '', primary);
    if (content.isEmpty) return;
    final size = (el.size ?? 6).clamp(1, 16);
    _writeAlign(out, el.align ?? 'center');
    // 五步序列与参考实现 writeQrCodeNative 逐字节一致：
    // 1. 模型 2：1D 28 6B 04 00 31 41 02 00
    out.addAll([0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x02, 0x00]);
    // 2. 模块大小：1D 28 6B 03 00 31 43 n
    out.addAll([0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, size]);
    // 3. 纠错 M(15%)：1D 28 6B 03 00 31 45 31
    out.addAll([0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31]);
    // 4. 存数据：1D 28 6B pL pH 31 50 30 data
    final data = gbk.encode(content);
    final len = data.length + 3;
    out.addAll([
      0x1D,
      0x28,
      0x6B,
      len & 0xFF,
      (len >> 8) & 0xFF,
      0x31,
      0x50,
      0x30,
    ]);
    out.addAll(data);
    // 5. 打印：1D 28 6B 03 00 31 51 30
    out.addAll([0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30]);
    out.addAll(_lf);
  }

  // ---- cut / cashDrawer ----

  void _writeCut(List<int> out, DslElement el) {
    // 切纸前留白 3 行（参考实现 writeCut 同口径）
    out.addAll([0x0A, 0x0A, 0x0A]);
    out.addAll([0x1D, 0x56, el.partial ? 0x01 : 0x00]);
  }

  void _writeCashDrawer(List<int> out, DslElement el) {
    final pulse = el.style['pulse'] ?? 1;
    final m = pulse == 2 ? 0x01 : 0x00;
    out.addAll([0x1B, 0x70, m, 0x19, 0x19]);
  }

  // ---- init/tail 命令白名单 ----

  List<int> _mapInitCommands(List<String> commands) {
    final out = <int>[];
    for (final cmd in commands) {
      final bytes = _mapKnownCommand(cmd);
      if (bytes != null && !_listEquals(bytes, _init)) {
        out.addAll(bytes);
      }
    }
    return out;
  }

  List<int> _mapTailCommands(List<String> commands) {
    final out = <int>[];
    for (final cmd in commands) {
      final bytes = _mapKnownCommand(cmd);
      if (bytes != null) out.addAll(bytes);
    }
    return out;
  }

  List<int>? _mapKnownCommand(String cmd) {
    final norm = cmd.trim().toUpperCase().replaceAll(RegExp(r'\s+'), ' ');
    switch (norm) {
      case 'ESC @':
        return const [0x1B, 0x40];
      case 'GS V 0':
      case 'GS V 48':
        return const [0x1D, 0x56, 0x00];
      case 'GS V 1':
      case 'GS V 49':
        return const [0x1D, 0x56, 0x01];
      default:
        return null;
    }
  }

  // ---- 基础写 ----

  void _writeAlign(List<int> out, String align) {
    int n = 0x00;
    if (align == 'center') {
      n = 0x01;
    } else if (align == 'right') {
      n = 0x02;
    }
    out.addAll([0x1B, 0x61, n]);
  }

  // ---- 文本宽度/对齐工具（与参考实现 EscPosTextUtil 同构）----

  /// 半角=1、全角=2 的简化 displayWidth（CJK 全部按 2 计）。
  int _displayWidth(String s) {
    var w = 0;
    for (final code in s.runes) {
      w += (code >= 0x1100 && _isWide(code)) ? 2 : 1;
    }
    return w;
  }

  bool _isWide(int code) {
    // CJK 基本/扩展区、全角 ASCII、中文标点等：按全角 2 处理。
    return (code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3000 && code <= 0x303F) ||
        (code >= 0xFF00 && code <= 0xFFEF);
  }

  String _pad(String s, int width, String align) {
    final w = _displayWidth(s);
    if (w >= width) return _truncate(s, width);
    final pad = ' ' * (width - w);
    if (align == 'right') return '$pad$s';
    if (align == 'center') {
      final left = pad.length ~/ 2;
      return '${' ' * left}$s${' ' * (pad.length - left)}';
    }
    return '$s$pad';
  }

  String _padLeft(String s, int width) => _pad(s, width, 'left');

  String _truncate(String s, int width) {
    final buf = StringBuffer();
    var w = 0;
    for (final char in s.runes) {
      final cw = _isWide(char) ? 2 : 1;
      if (w + cw > width) break;
      buf.writeCharCode(char);
      w += cw;
    }
    return buf.toString();
  }

  String _separator(int widthCols) => '-' * widthCols;

  bool _listEquals(List<int> a, List<int> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}
