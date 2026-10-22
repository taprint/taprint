// SPDX-License-Identifier: Apache-2.0
/// TCP-9100 执行器：WiFi 网口打印机原始套接字通道（dart:io Socket，
/// 无第三方依赖）。9100 是行式打印机事实标准裸端口：连上即写，
/// 打印机自身流控。
library;

import 'dart:io';
import 'dart:typed_data';

import 'print_executor.dart';

/// 纯 Dart 实现（无平台通道），可在 Dart VM / flutter test 下直测。
class Tcp9100Executor implements PrintExecutor {
  Tcp9100Executor({
    Duration connectTimeout = const Duration(seconds: 5),
    TransportLogger? logger,
  })  : _connectTimeout = connectTimeout,
        _logger = logger;

  final Duration _connectTimeout;
  final TransportLogger? _logger;

  Socket? _socket;

  @override
  bool get isConnected => _socket != null;

  @override
  Future<void> connect(PrintDevice device) async {
    final host = device.host;
    if (host == null || host.isEmpty) {
      throw StateError('TCP 设备缺少 host');
    }
    _socket = await Socket.connect(
      host,
      device.port,
      timeout: _connectTimeout,
    );
    _logger?.call('tcp9100 connected to $host:${device.port}');
  }

  @override
  Future<void> writeBytes(Uint8List bytes) async {
    final socket = _socket;
    if (socket == null) throw StateError('TCP 未连接');
    socket.add(bytes);
    await socket.flush();
  }

  @override
  Future<void> disconnect() async {
    final socket = _socket;
    _socket = null;
    if (socket == null) return;
    await socket.close();
    socket.destroy();
    _logger?.call('tcp9100 disconnected');
  }
}
