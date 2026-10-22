// SPDX-License-Identifier: Apache-2.0
// CPCL 指令编码器（标签方言，权威口径以标签打印语法文档为准——
// 部分速查表的简写形态有误，勿按速查表实现）。
//
// 要点：
// - 格式头 `! offset horz vert height qty`（200 DPI，8 dot/mm，
//   与 TSPL 同换算）；
// - TEXT 内容不带引号（行尾结束）：`TEXT font size x y content`；
// - 一维码 `BARCODE type width ratio height x y content`；
// - QR 三段式：`BARCODE QR x y M 2 U n` / 数据行 / `ENDQR`；
// - 数据行按三字符形态 `M0A,data`（ECC M + 掩码 0 + 模式 A 自动）。
//   两字符 `MA,` 形态（掩码省略→自动）在部分机型上的兼容性须真机
//   校准确认，校准前按三字符形态出指令；
// - 尾部 `FORM` / `PRINT`；份数 qty 在格式头末参；
// - 码制白名单与 TSPL 同口径（CODE128/EAN13，其余拒绝不印+告警）。

import 'dart:convert';
import 'dart:typed_data';

import 'expression_compiler.dart';
import 'gbk_codec.dart';
import 'label_layout.dart';
import 'printer_log.dart';
import 'tspl_encoder.dart' show kTsplBarcodeHumanReadable;

/// QR 单元值域收窄开关（默认 false = 保持 1-32 既有行为；置 true 时
/// 与 TSPL 的 1-10 域一致。翻转须真机校准后定版，禁无校准改动语义）。
const bool kCpclQrClampNarrow = false;

class CpclEncoder {
  CpclEncoder({GbkEncoder? gbk}) : gbk = gbk ?? const GbkFullCodec();

  final GbkEncoder gbk;

  /// 编码标签规格为 CPCL 字节流（primary 供内容表达式插值与 qty 求值）。
  Uint8List encode(LabelSpec spec, Map<String, dynamic> primary) {
    final out = BytesBuilder();
    _ascii(out, '! 0 200 200 ${mmToDot(spec.heightMm)} '
        '${_resolveQty(spec, primary)}\n');
    for (final el in spec.body) {
      _encodeElement(out, el, primary);
    }
    _ascii(out, 'FORM\n');
    _ascii(out, 'PRINT\n');
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
        final w = mmToDot(el.widthMm);
        final h = mmToDot(el.heightMm);
        _ascii(out, 'LINE $x $y ${x + w} $y ${h < 1 ? 1 : h}\n');
        break;
      default:
        // 未知元素跳过：绝对坐标布局无占位语义（与 TSPL 编码器同口径）。
        break;
    }
  }

  // ---- TEXT（内容不带引号，行尾结束）----

  void _encodeText(
    BytesBuilder out,
    LabelElement el,
    int x,
    int y,
    Map<String, dynamic> primary,
  ) {
    final content = ExpressionCompiler.interpolate(el.content, primary);
    if (content.isEmpty) return;
    // 顶层 size 为准（font 4 位图字体仅纵向放大，档 0-4——倍率 1→档 0
    // 不放大、2/3/4→同档、≥5 顶格 4）；缺省回 style.fontSize 兼容档。
    final size = _resolveCpclTextSize(el);
    _ascii(out, 'TEXT 4 $size $x $y ');
    out.add(gbk.encode(content));
    _ascii(out, '\n');
  }

  /// CPCL 档位（0-4）解析，与 TSPL resolveTextMultiplier 同源顶层
  /// size 语义（两方言参数面不同：TSPL x-mul/y-mul 连续 1-10；
  /// CPCL 单档）。
  static int _resolveCpclTextSize(LabelElement el) {
    final t = el.textSize;
    if (t != null) {
      final m = t == 0 ? 1 : t.clamp(1, 10);
      return m <= 1 ? 0 : (m > 4 ? 4 : m);
    }
    return _mapStyleFontSize((el.style['fontSize'] ?? 'normal').toString());
  }

  /// style.fontSize 兼容档（遗留消费路径）→ CPCL 档 0-4。
  static int _mapStyleFontSize(String name) {
    switch (name) {
      case 'double':
        return 2;
      case 'triple':
        return 3;
      case 'quadruple':
        return 4;
      default:
        // normal/tall/wide：font 4 为位图字体仅纵向放大，wide 无横向
        // 参数，统一按默认 size 0；真机字号校准后如需分档再扩。
        return 0;
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
    final type = mapSymbology(el.symbology);
    if (type == null) {
      // 码制白名单外拒绝不印+告警（与 TSPL 同口径）。
      PrintersLog.warn(
          'label 码制 "${el.symbology}" 不在白名单（CODE128/EAN13），该条码不印',
          key: 'label-encoder:symbology:${el.symbology}');
      return;
    }
    final height = mmToDot(el.heightMm);
    // BARCODE type width ratio height x y content
    _ascii(out, 'BARCODE $type 2 1 $height $x $y ');
    out.add(gbk.encode(content));
    _ascii(out, '\n');
    // 人读号预备：开关开时补 BARCODE-TEXT HRI 行（默认关=不发，
    // 与 TSPL 同一开关）。
    if (kTsplBarcodeHumanReadable == 1) {
      _ascii(out, 'BARCODE-TEXT 4 0 $x $y ');
      out.add(gbk.encode(content));
      _ascii(out, '\n');
    }
  }

  /// 码制映射（CPCL 助记符）：白名单直通、其余 null（拒绝）。
  static String? mapSymbology(String symbology) {
    switch (symbology.toUpperCase()) {
      case 'CODE128':
        return '128';
      case 'EAN13':
        return 'EAN13';
      default:
        return null;
    }
  }

  // ---- QR 三段式 ----

  void _encodeQrcode(
    BytesBuilder out,
    LabelElement el,
    int x,
    int y,
    Map<String, dynamic> primary,
  ) {
    final content = ExpressionCompiler.interpolate(el.content, primary);
    if (content.isEmpty) return;
    // 默认 1-32（既有行为）；kCpclQrClampNarrow=true 时收窄 1-10
    //（与 TSPL 同域——开关面，翻转须真机校准）。
    final unit = el.cellSize.clamp(1, kCpclQrClampNarrow ? 10 : 32);
    // 段 1：BARCODE QR x y M 2 U n（M=QR 型号 2，官方默认；U=单元大小）
    _ascii(out, 'BARCODE QR $x $y M 2 U $unit\n');
    // 段 2：数据行三字符形态 M0A,data（ECC M + 掩码 0 + 模式 A 自动；
    // 两字符 MA, 形态待真机校准）
    _ascii(out, 'M0A,');
    out.add(gbk.encode(content));
    _ascii(out, '\n');
    // 段 3：ENDQR
    _ascii(out, 'ENDQR\n');
  }

  // ---- 工具 ----

  void _ascii(BytesBuilder out, String s) => out.add(latin1.encode(s));

  int _resolveQty(LabelSpec spec, Map<String, dynamic> primary) {
    final template = spec.copiesTemplate;
    if (template == null) return 1;
    final resolved = ExpressionCompiler.interpolate(template, primary);
    return int.tryParse(resolved.trim()) ?? 1;
  }
}
