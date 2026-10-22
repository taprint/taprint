// SPDX-License-Identifier: Apache-2.0
// 标签呈现（presentations.label）解析与布局纯函数——TSPL/CPCL 编码器的
// 共用布局层。
//
// 口径：presentation.size 定纸面（缺省 40×30mm），元素绝对坐标 mm；
// 光栅化按 8 dot/mm（203dpi 标签机）换算 dot。解析只做兼容收面：
// 未知元素类型/未知 schemaVersion 跳过或告警，不拒载。

import 'dart:convert';

import 'printer_log.dart';

/// 标签规格（presentations.label 解析产物）。
class LabelSpec {
  const LabelSpec({
    required this.widthMm,
    required this.heightMm,
    this.gapMm = 2,
    this.density = 8,
    this.speed = 4,
    this.copiesTemplate,
    required this.body,
  });

  final double widthMm;
  final double heightMm;

  /// 标签间隙 mm（TSPL GAP 第二段口径）。
  final double gapMm;

  /// 打印浓度 0-15（TSPL DENSITY）。
  final int density;

  /// 打印速度（TSPL SPEED）。
  final int speed;

  /// 份数模板：DSL label.copies（int 或字符串模板），null → 编码器按 1。
  final String? copiesTemplate;

  final List<LabelElement> body;
}

/// 标签元素（绝对坐标 mm；text/barcode/qrcode/line，其余类型编码器跳过）。
class LabelElement {
  const LabelElement({
    required this.type,
    this.xMm = 0,
    this.yMm = 0,
    this.widthMm = 20,
    this.heightMm = 6,
    this.content = '',
    this.style = const {},
    this.symbology = 'CODE128',
    this.cellSize = kQrcodeCellDefault,
    this.textSize,
  });

  final String type;
  final double xMm;
  final double yMm;
  final double widthMm;
  final double heightMm;

  /// text/barcode/qrcode 的内容模板（编码器负责表达式插值）。
  final String content;
  final Map<String, dynamic> style;

  /// barcode 条码体系（CODE128/EAN13；白名单外码制拒绝不印+告警）。
  final String symbology;

  /// qrcode 单元大小（TSPL cell_width 1-10 缺省 [kQrcodeCellDefault]=4；
  /// CPCL U 1-32）。
  final int cellSize;

  /// text 顶层 `size` 字号倍率（编码器以顶层 size 为准，域 1-10、
  /// 0 折 1；null=模板未写顶层 size → 编码器按 style.fontSize 兼容档
  /// 读，再缺省 1）。
  final int? textSize;
}

/// 203dpi → 8 dot/mm（TSPL 机口径；CPCL 200dpi 同按 8 dot/mm）。
const int labelDotsPerMm = 8;

/// qrcode 模块格缺省（域 1-10、缺省 4）。模板显式写 size 时本值不参与。
const int kQrcodeCellDefault = 4;

int mmToDot(double mm) => (mm * labelDotsPerMm).round();

/// 编码器可渲染的元素类型集合（此集合外的 type 记告警跳过、不炸）。
const Set<String> kKnownLabelElementTypes = {
  'text', 'barcode', 'qrcode', 'line',
};

/// 已知 DSL 版本前缀（schemaVersion 以 `1.` 开头的 1.x 档；其余版本
/// 兼容继续解析但记告警——禁直接拒载）。
const String kKnownLabelSchemaVersionPrefix = '1.';

class LabelLayoutParser {
  const LabelLayoutParser._();

  /// 解析 DSL JSON 的 presentations.label 子树；缺失抛 [FormatException]。
  ///
  /// [onWarning]：兼容面告警回调（未知 type/未知 schemaVersion 等跳过
  /// 但不拒载的场景；每处一条，供测试断言）。同时经 [PrintersLog]
  /// 上报（[LabelParserLog] 节流——高频重解析不刷屏）。
  static LabelSpec parse(String json, {void Function(String message)? onWarning}) {
    final dynamic root = jsonDecode(json);
    if (root is! Map) {
      throw const FormatException('DSL 根必须为对象');
    }
    _warnUnknownSchemaVersion(root, onWarning);
    final presentations = root['presentations'];
    if (presentations is! Map || presentations['label'] is! Map) {
      throw const FormatException('DSL 缺 presentations.label 节');
    }
    final label = presentations['label'] as Map<String, dynamic>;
    final size = label['size'];
    final sizeMap = size is Map ? size : const <String, dynamic>{};
    final bodyRaw = label['body'];
    if (bodyRaw is! List) {
      throw const FormatException('DSL label.body 必须为数组');
    }
    final body = <LabelElement>[];
    for (final e in bodyRaw) {
      if (e is Map<String, dynamic>) {
        final el = _parseElement(e);
        if (!kKnownLabelElementTypes.contains(el.type)) {
          _warn('未知元素类型 "${el.type}" 跳过不渲染（兼容解析不拒载）',
              onWarning);
        }
        body.add(el);
      } else {
        _warn('body 含非对象元素，跳过', onWarning);
      }
    }
    final dynamic copies = label['copies'];
    return LabelSpec(
      widthMm: _parseLengthMm(sizeMap['width']) ?? 40,
      heightMm: _parseLengthMm(sizeMap['height']) ?? 30,
      gapMm: _parseLengthMm(label['gap']) ?? 2,
      density: _parseInt(label['density']) ?? 8,
      speed: _parseInt(label['speed']) ?? 4,
      copiesTemplate: copies?.toString(),
      body: body,
    );
  }

  static void _warnUnknownSchemaVersion(
    Map root,
    void Function(String message)? onWarning,
  ) {
    final v = root['schemaVersion'];
    final s = v is String ? v : '';
    if (s.isEmpty) return; // 无版本字段：合法形态，不告警
    if (!s.startsWith(kKnownLabelSchemaVersionPrefix)) {
      _warn('未知 schemaVersion="$s"，按已知最高兼容档解析（禁拒载）', onWarning);
    }
  }

  static void _warn(String msg, void Function(String message)? onWarning) {
    onWarning?.call(msg);
    // 解析层保持纯函数语义：落盘走全局出口且按消息 key 节流
    //（同模板重解析不刷屏）。
    LabelParserLog.warn(msg);
  }

  static LabelElement _parseElement(Map<String, dynamic> raw) {
    final styleRaw = raw['style'];
    return LabelElement(
      type: (raw['type'] as String?) ?? 'unknown',
      xMm: _parseLengthMm(raw['x']) ?? 0,
      yMm: _parseLengthMm(raw['y']) ?? 0,
      widthMm: _parseLengthMm(raw['width']) ?? 20,
      heightMm: _parseLengthMm(raw['height']) ?? 6,
      content: (raw['content'] as String?) ?? '',
      style: styleRaw is Map
          ? Map<String, dynamic>.from(styleRaw)
          : const <String, dynamic>{},
      symbology: (raw['symbology'] as String?) ?? 'CODE128',
      cellSize: _parseInt(raw['size']) ?? kQrcodeCellDefault,
      textSize: _parseInt(raw['size']),
    );
  }

  /// 长度解析："40mm"/"40"/40/40.5 → mm 数值；null/非法 → null。
  static double? _parseLengthMm(dynamic raw) {
    if (raw is num) return raw.toDouble();
    if (raw is String) {
      final s = raw.toLowerCase().trim();
      final stripped =
          s.endsWith('mm') ? s.substring(0, s.length - 2) : s;
      return double.tryParse(stripped.trim());
    }
    return null;
  }

  static int? _parseInt(dynamic raw) {
    if (raw is int) return raw;
    if (raw is String) return int.tryParse(raw.trim());
    return null;
  }
}

/// 解析层兼容告警出口：按消息前缀节流——同模板重解析（兜底链高频）
/// 不刷告警，同类告警 10 分钟至多一条；实际落盘经 [PrintersLog]
///（宿主注入，默认静默）。
class LabelParserLog {
  LabelParserLog._();

  static final Set<String> _recentKeys = {};
  static final Map<String, DateTime> _lastAt = {};

  static void warn(String message) {
    final key = message.length > 24 ? message.substring(0, 24) : message;
    final now = DateTime.now();
    final last = _lastAt[key];
    if (last != null && now.difference(last) < const Duration(minutes: 10)) {
      return;
    }
    _lastAt[key] = now;
    _recentKeys.add(key);
    // 收敛内存：节流表只留最近键。
    if (_recentKeys.length > 64) {
      final drop = _recentKeys.first;
      _recentKeys.remove(drop);
      _lastAt.remove(drop);
    }
    PrintersLog.warn('[LabelParser] $message', key: 'label-parser:$key');
  }
}
