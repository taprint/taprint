// SPDX-License-Identifier: Apache-2.0
// 打印编码器内核日志抽象：函数注入、默认静默。
// 本包为纯 Dart 内核，不带平台 IO；编码器产生的兼容面事件（未知码制
// 拒绝、未知元素类型跳过等）只经本出口上报，落盘/打印由宿主决定。

/// 告警出口签名。[key] 为调用方提供的去重/节流键（可为空串）。
typedef PrinterWarnFn = void Function(String message, {String key});

/// 编码器内核日志出口。
///
/// 默认静默：未注入 [sink] 时 [warn] 为无操作（编码路径零副作用，
/// 测试可确定性断言）。宿主注入示例：
///
/// ```dart
/// PrintersLog.sink = (message, {key = ''}) => log.warn('[taprint:$key] $message');
/// ```
class PrintersLog {
  PrintersLog._();

  /// 宿主注入的告警出口；null = 静默（默认）。
  static PrinterWarnFn? sink;

  /// 上报一条告警；未注入出口时丢弃。
  static void warn(String message, {String key = ''}) {
    sink?.call(message, key: key);
  }
}
