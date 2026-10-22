// SPDX-License-Identifier: Apache-2.0
// TSPL2 指令编码器（标签方言，TSPL2 语法 v1.7 修正口径）。
//
// 要点：
// - 头部 SIZE/GAP/DENSITY/SPEED/DIRECTION/CLS，绝对坐标布局
//   （dot = mm × 8，203dpi）；
// - TEXT 完整 7 参 `TEXT x,y,"font",rotation,x-mul,y-mul,"content"`
//   （rotation 是第 4 参；中文字体 SIMPLIFIED CHINESE）。
//   字号倍率：顶层 `size` 为准（域 1-10、0 折 1），缺省回
//   style.fontSize 兼容档，再缺省 1；
// - BARCODE `x,y,"type",height,human-readable,rotation,narrow,wide,"content"`。
//   码制白名单：仅 CODE128/EAN13 直通，其余拒绝不印+告警
//   （禁静默折 CODE128）；human-readable 位挂 [kTsplBarcodeHumanReadable]；
// - QRCODE 9 参 `x,y,ECC,cell_width,mode,rotation,model,mask,"data"`
//   （ECC=M、mode=A 自动、model=M、mask=7）；
// - 内容走 [GbkEncoder]（默认 GB18030 双字节区全表通道）；
// - copies 通过 `PRINT n` 控制。
// 数值字段格式遵循 ADR-0009（编码器内禁平台默认浮点转串）。

import 'dart:convert';
import 'dart:typed_data';

import 'expression_compiler.dart';
import 'gbk_codec.dart';
import 'label_layout.dart';
import 'printer_log.dart';

/// 一维码人读号开关（默认 0 = 恒不印，与既有 golden 行为一致；
/// 置 1 启用后须真机校准字距再定版，禁无校准翻动）。
const int kTsplBarcodeHumanReadable = 0;

class TsplEncoder {
  TsplEncoder({GbkEncoder? gbk}) : gbk = gbk ?? const GbkFullCodec();

  final GbkEncoder gbk;

  /// 编码标签规格为 TSPL 字节流（primary 供内容表达式插值与 copies 求值）。
  Uint8List encode(LabelSpec spec, Map<String, dynamic> primary) {
    final out = BytesBuilder();
    _ascii(out, 'SIZE ${_fmtMm(spec.widthMm)}mm,${_fmtMm(spec.heightMm)}mm\n');
    _ascii(out, 'GAP ${_fmtMm(spec.gapMm)}mm,0\n');
    _ascii(out, 'DENSITY ${spec.density}\n');
    _ascii(out, 'SPEED ${spec.speed}\n');
    _ascii(out, 'DIRECTION 1\n');
    _ascii(out, 'CLS\n');
    for (final el in spec.body) {
      _encodeElement(out, el, primary);
    }
    _ascii(out, 'PRINT ${_resolveCopies(spec, primary)}\n');
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
        // TSPL BAR：实心矩形，宽度=元素宽、厚度按高度 dot
        //（高度缺省极细，最低 1 dot）。
        final w = mmToDot(el.widthMm);
        final h = mmToDot(el.heightMm);
        _ascii(out, 'BAR $x,$y,$w,${h < 1 ? 1 : h}\n');
        break;
      default:
        // 未知元素（image/box 等）跳过：绝对坐标布局无「空行」占位语义。
        break;
    }
  }

  // ---- TEXT ----

  void _encodeText(
    BytesBuilder out,
    LabelElement el,
    int x,
    int y,
    Map<String, dynamic> primary,
  ) {
    final content = ExpressionCompiler.interpolate(el.content, primary);
    final mul = resolveTextMultiplier(el);
    // TEXT x,y,"font",rotation,x-mul,y-mul,"content"（参数序修正版）
    _ascii(out, 'TEXT $x,$y,"SIMPLIFIED CHINESE",0,${mul.$1},${mul.$2},"');
    out.add(gbk.encode(content));
    _ascii(out, '"\n');
  }

  /// 字号倍率解析：顶层 size 为准（0 折 1、clamp 1-10——x-mul=y-mul 同
  /// 倍），缺省回 style.fontSize 兼容档，再缺省 (1,1)。
  /// 静态开放供几何/预览层同口径复用（两处同源防分叉）。
  static (int, int) resolveTextMultiplier(LabelElement el) {
    final t = el.textSize;
    if (t != null) {
      final m = t == 0 ? 1 : t.clamp(1, 10);
      return (m, m);
    }
    return _mapStyleFontSize((el.style['fontSize'] ?? 'normal').toString());
  }

  /// style.fontSize 兼容档（遗留消费路径）→ (x-mul, y-mul)。
  static (int, int) _mapStyleFontSize(String name) {
    switch (name) {
      case 'tall':
        return (1, 2);
      case 'wide':
        return (2, 1);
      case 'double':
        return (2, 2);
      case 'triple':
        return (3, 3);
      case 'quadruple':
        return (4, 4);
      default:
        return (1, 1);
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
    final height = mmToDot(el.heightMm);
    final type = mapSymbology(el.symbology);
    if (type == null) {
      // 码制白名单仅 CODE128/EAN13，其余拒绝不印+告警（禁静默折
      // CODE128——模板闸是第一道防线，此处是运行时兜底）。
      // key 节流防同模板重编码刷屏。
      PrintersLog.warn(
          'label 码制 "${el.symbology}" 不在白名单（CODE128/EAN13），该条码不印',
          key: 'label-encoder:symbology:${el.symbology}');
      return;
    }
    // BARCODE x,y,"type",height,human-readable,rotation(0),narrow(2),wide(2),"content"
    // human-readable 位挂全局开关（默认 0 恒不印）。
    _ascii(
        out,
        'BARCODE $x,$y,"$type",$height,$kTsplBarcodeHumanReadable,0,2,2,"');
    out.add(gbk.encode(content));
    _ascii(out, '"\n');
  }

  /// 码制映射：白名单直通、其余 null（拒绝）。几何层条码宽估算与
  /// 移动端就绪判定同口径。
  static String? mapSymbology(String symbology) {
    switch (symbology.toUpperCase()) {
      case 'CODE128':
        return 'CODE128';
      case 'EAN13':
        return 'EAN13';
      default:
        return null;
    }
  }

  // ---- QRCODE ----

  void _encodeQrcode(
    BytesBuilder out,
    LabelElement el,
    int x,
    int y,
    Map<String, dynamic> primary,
  ) {
    final content = ExpressionCompiler.interpolate(el.content, primary);
    if (content.isEmpty) return;
    final cell = el.cellSize.clamp(1, 10);
    // QRCODE x,y,ECC,cell_width,mode,rotation,model,mask,"data"
    //（ECC=M、mode=A 自动、model=M、mask=7）
    _ascii(out, 'QRCODE $x,$y,M,$cell,A,0,M,7,"');
    out.add(gbk.encode(content));
    _ascii(out, '"\n');
  }

  // ---- 工具 ----

  void _ascii(BytesBuilder out, String s) => out.add(latin1.encode(s));

  int _resolveCopies(LabelSpec spec, Map<String, dynamic> primary) {
    final template = spec.copiesTemplate;
    if (template == null) return 1;
    final resolved = ExpressionCompiler.interpolate(template, primary);
    return int.tryParse(resolved.trim()) ?? 1;
  }

  String _fmtMm(double mm) {
    return mm == mm.roundToDouble() ? mm.round().toString() : mm.toString();
  }
}
