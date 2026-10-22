// SPDX-License-Identifier: Apache-2.0
// ZPL 指令编码器（标签方言，v0.2 内置字库路由——ADR-0001；CJK 位图路由
// ^GFA 留给 v0.2.x 增量，本面不发）。
//
// 参照：Java ZplRenderer（自研，提取源工程收编移植）：
// - 帧骨架 `^XA^LH0,0^PW<w>^LL<h> → 元素 → [^PQ<n>] → ^XZ`（^PQ 仅份数 >1 时发）；
// - 文本逐行 `^FOx,y^A0N,h,h^FD<escaped>^FS`，h = 28 × 倍率（域 1-10），
//   行距 = 字高；CJK 内容同走内置字库路由（v0.2 口径）；
// - 一维码 `^FOx,y^BY2,3,<h>` + 码制指令 + `^FD^FS`（全表映射：CODE128→^BCN、
//   EAN13/EAN8→^BEN、UPC→^BUN、CODE39→^B3N、ITF→^B2N；未知折 CODE128——
//   Java 参照 Symbology.of 口径，与 TSPL/CPCL 编码器「拒绝不印」纪律不同）；
// - QR `^FOx,y^BQN,2,<size>^FDMA,<data>^FS`（MA 前缀 = 纠错 M + 掩码自动，
//   size 域 1-10 缺省 6）；
// - 线/框 `^FOx,y^GB<w>,<h>,2^FS`（线 = 细框，线高下夹厚度 2）；
// - ^FD 域转义：反斜杠先行，^ ~ → \^ \~（ZPL II 指令前缀子集）。
// 内容通道：GBK/GB18030（注入 GbkEncoder，缺省全表）+ 表外字符 U+FFFD 占位
// （ADR-0009 §3——gbk_full 通道自带该策略；帧结构字符均为 ASCII，逐字节不变）。
// dot 折算：8 dot/mm（label_layout.mmToDot 同口径；Java 参照 203/25.4 ≈ 7.9921，
// 非整点坐标中点差异登记 docs/conformance.md Z 段）。

import 'dart:convert';
import 'dart:typed_data';

import 'expression_compiler.dart';
import 'gbk_codec.dart';
import 'label_layout.dart';

/// ^A0 内置字库基准字高（dot）——Java 参照 ASCII_FONT_HEIGHT 同口径。
const int kZplAsciiFontHeight = 28;

/// 线/框厚度缺省（dot）——Java 参照 BOX_THICKNESS 同档。
const int kZplBoxThickness = 2;

class ZplEncoder {
  ZplEncoder({GbkEncoder? gbk}) : gbk = gbk ?? const GbkFullCodec();

  final GbkEncoder gbk;

  /// 编码标签规格为 ZPL 字节流（primary 供内容表达式插值与份数求值）。
  Uint8List encode(LabelSpec spec, Map<String, dynamic> primary) {
    final out = BytesBuilder();
    _ascii(out,
        '^XA^LH0,0^PW${mmToDot(spec.widthMm)}^LL${mmToDot(spec.heightMm)}');
    for (final el in spec.body) {
      _encodeElement(out, el, primary);
    }
    final copies = _resolveQty(spec, primary);
    if (copies > 1) {
      _ascii(out, '^PQ$copies');
    }
    _ascii(out, '^XZ');
    return out.toBytes();
  }

  void _encodeElement(
    BytesBuilder out,
    LabelElement el,
    Map<String, dynamic> primary,
  ) {
    final x = mmToDot(el.xMm);
    final y = mmToDot(el.yMm);
    switch (el.type) {
      case 'text':
        _encodeText(out, el, x, y, primary);
        break;
      case 'barcode':
        _encodeBarcode(out, el, x, y, primary);
        break;
      case 'qrcode':
        _encodeQrcode(out, el, x, y, primary);
        break;
      case 'line':
        // 线 = 细框：长度 w、线高 = height 折算下夹厚度（零高度框无 ZPL 语义）。
        final w = mmToDot(el.widthMm);
        final stroke = _clampInt(mmToDot(el.heightMm), kZplBoxThickness, 1 << 30);
        _ascii(out, '^FO$x,$y^GB$w,$stroke,$kZplBoxThickness^FS');
        break;
      case 'rect':
        _ascii(out, '^FO$x,$y^GB${mmToDot(el.widthMm)},'
            '${mmToDot(el.heightMm)},$kZplBoxThickness^FS');
        break;
      default:
        // 未知元素跳过：绝对坐标布局无占位语义（与 TSPL/CPCL 编码器同口径）。
        break;
    }
  }

  // ---- TEXT（逐行 ^FD，行距 = 字高）----

  void _encodeText(
    BytesBuilder out,
    LabelElement el,
    int x,
    int y,
    Map<String, dynamic> primary,
  ) {
    final content = ExpressionCompiler.interpolate(el.content, primary);
    if (content.isEmpty) return;
    final mul = _resolveTextMultiplier(el);
    final h = kZplAsciiFontHeight * mul;
    final lines = content.split('\n');
    for (var lineNo = 0; lineNo < lines.length; lineNo++) {
      _ascii(out, '^FO$x,${y + lineNo * h}^A0N,$h,${h}^FD');
      out.add(gbk.encode(escapeFieldData(lines[lineNo])));
      _ascii(out, '^FS');
    }
  }

  /// 文本倍率（Java 参照口径：顶层 size 为准，域 1-10、0 折 1；缺省回
  /// style.fontSize 兼容档——Java 参照不读 style，潜在分叉面登记 conformance）。
  static int _resolveTextMultiplier(LabelElement el) {
    final t = el.textSize;
    if (t != null) {
      return _clampInt(t == 0 ? 1 : t, 1, 10);
    }
    switch ((el.style['fontSize'] ?? 'normal').toString()) {
      case 'double':
        return 2;
      case 'triple':
        return 3;
      case 'quadruple':
        return 4;
      default:
        return 1;
    }
  }

  // ---- BARCODE ----

  void _encodeBarcode(
    BytesBuilder out,
    LabelElement el,
    int x,
    int y,
    Map<String, dynamic> primary,
  ) {
    final content = ExpressionCompiler.interpolate(el.content, primary);
    if (content.isEmpty) return;
    final height = mmToDot(el.heightMm);
    // ^FO + ^BY2,3,<h>（窄条 2 dot、宽窄比 3）+ 码制指令 + ^FD + ^FS
    _ascii(out,
        '^FO$x,$y^BY2,3,$height${symbologyCommand(el.symbology, height)}^FD');
    out.add(gbk.encode(escapeFieldData(content)));
    _ascii(out, '^FS');
  }

  /// 码制指令（Java 参照全表；未知折 CODE128——Symbology.of 缺省口径）。
  static String symbologyCommand(String symbology, int height) {
    switch (symbology.toUpperCase()) {
      case 'EAN13':
        return '^BEN,$height,Y,N,N';
      case 'EAN8':
        return '^BEN,$height,Y,N';
      case 'UPC':
      case 'UPCA':
        return '^BUN,$height,Y,N';
      case 'CODE39':
        return '^B3N,N,$height,Y,N';
      case 'ITF':
      case 'I2OF5':
        return '^B2N,$height,N,N';
      default:
        // 含 CODE128 与未知码制：Symbology.of 缺省折 CODE128
        return '^BCN,$height,Y,N,N';
    }
  }

  // ---- QR ----

  void _encodeQrcode(
    BytesBuilder out,
    LabelElement el,
    int x,
    int y,
    Map<String, dynamic> primary,
  ) {
    final content = ExpressionCompiler.interpolate(el.content, primary);
    if (content.isEmpty) return;
    final size = _clampInt(el.cellSize, 1, 10);
    // ^BQN,2,<size>^FDMA,<data>^FS（型号 2 + MA = 纠错 M + 掩码自动）
    _ascii(out, '^FO$x,$y^BQN,2,$size^FDMA,');
    out.add(gbk.encode(escapeFieldData(content)));
    _ascii(out, '^FS');
  }

  // ---- 工具 ----

  void _ascii(BytesBuilder out, String s) => out.add(latin1.encode(s));

  int _resolveQty(LabelSpec spec, Map<String, dynamic> primary) {
    final template = spec.copiesTemplate;
    if (template == null) return 1;
    final resolved = ExpressionCompiler.interpolate(template, primary);
    return int.tryParse(resolved.trim()) ?? 1;
  }

  /// 整数区间夹取（int.clamp 返回 num，这里显式收 int）。
  static int _clampInt(int value, int min, int max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }
}

/// ^FD 域转义：反斜杠先行 → \\，指令前缀 ^ ~ → \^ \~（ZPL II 子集）。
String escapeFieldData(String text) {
  final sb = StringBuffer();
  for (final ch in text.codeUnits) {
    if (ch == 0x5c || ch == 0x5e || ch == 0x7e) {
      sb.writeCharCode(0x5c);
    }
    sb.writeCharCode(ch);
  }
  return sb.toString();
}

/// 码制指令独立导出（测试与宿主复用；语义同 ZplEncoder.symbologyCommand）。
String zplSymbologyCommand(String symbology, int height) =>
    ZplEncoder.symbologyCommand(symbology, height);
