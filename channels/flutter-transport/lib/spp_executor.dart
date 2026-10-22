// SPDX-License-Identifier: Apache-2.0
// SPP 执行器（Android 蓝牙串口 / RFCOMM）。
//
// 技术裁定：MethodChannel + Android 原生 BluetoothSocket 自研，不引
// 长期停更的第三方蓝牙串口插件。Dart 侧只做协议桥与连接状态维护；
// RFCOMM 连接/读写由宿主 App 内的原生 SppChannel.kt 实现
// （见本包 android/ 目录；channel 名 [SppExecutor.channelName] 两侧
// 一致，SPP 标准 service UUID 00001101-0000-1000-8000-00805F9B34FB）。
//
// 异常语义对齐 Tcp9100Executor：参数缺失/未连接抛 StateError；
// 连接超时由本层 [connectTimeout] 统一口径（原生 connect 阻塞在
// RFCOMM 握手，超时后主动清理残留 socket 再抛 TimeoutException）。
// 写失败视为链路断（对齐 BleExecutor 断连检测语义），置未连接。
// ignore_for_file: prefer_initializing_formals

import 'dart:async';

import 'package:flutter/services.dart';

import 'print_executor.dart';

class SppExecutor implements PrintExecutor {
  SppExecutor({
    MethodChannel? channel,
    Duration connectTimeout = const Duration(seconds: 10),
    TransportLogger? logger,
  })  : _channel = channel ?? const MethodChannel(channelName),
        _connectTimeout = connectTimeout,
        _logger = logger;

  /// MethodChannel 名（与 android/ 下 SppChannel.kt 的 CHANNEL 一致）。
  static const String channelName = 'dev.taprint.channel_flutter/spp';

  final MethodChannel _channel;

  /// RFCOMM 握手比 TCP 慢（蓝牙页面扫描/服务发现），取 BLE 同级 10s
  /// 而非 TCP 的 5s。
  final Duration _connectTimeout;
  final TransportLogger? _logger;

  String? _address;
  bool _connected = false;

  @override
  bool get isConnected => _connected && _address != null;

  @override
  Future<void> connect(PrintDevice device) async {
    final address = device.address;
    if (address == null || address.isEmpty) {
      throw StateError('SPP 设备缺少 address（MAC）');
    }
    try {
      await _channel
          .invokeMethod<void>('connect', {'address': address})
          .timeout(_connectTimeout);
    } on TimeoutException {
      _connected = false;
      _address = null;
      unawaited(_invokeDisconnectQuietly());
      _logger?.call('spp connect timeout after '
          '${_connectTimeout.inSeconds}s: $address');
      throw TimeoutException(
        'SPP 连接超时（${_connectTimeout.inSeconds}s）',
        _connectTimeout,
      );
    } on PlatformException catch (e) {
      _connected = false;
      _address = null;
      _logger?.call('spp connect failed: ${e.code} ${e.message}');
      throw StateError('SPP 连接失败：${e.code} ${e.message}');
    }
    _address = address;
    _connected = true;
  }

  @override
  Future<void> writeBytes(Uint8List bytes) async {
    if (!isConnected) throw StateError('SPP 未连接');
    try {
      await _channel.invokeMethod<void>('writeBytes', {'bytes': bytes});
    } on PlatformException catch (e) {
      // 写失败视为链路断：置未连接，由上层重连。
      _connected = false;
      _logger?.call('spp write failed: ${e.code} ${e.message}');
      throw StateError('SPP 写入失败：${e.code} ${e.message}');
    }
  }

  @override
  Future<void> disconnect() async {
    final wasConnected = _address != null;
    _connected = false;
    _address = null;
    if (!wasConnected) return;
    try {
      await _channel.invokeMethod<void>('disconnect');
    } on PlatformException catch (e) {
      throw StateError('SPP 断开失败：${e.code} ${e.message}');
    }
  }

  /// 连接超时后的残留 socket 清理：尽力而为，失败不掩盖原始超时异常。
  Future<void> _invokeDisconnectQuietly() async {
    try {
      await _channel.invokeMethod<void>('disconnect');
    } catch (_) {}
  }
}
