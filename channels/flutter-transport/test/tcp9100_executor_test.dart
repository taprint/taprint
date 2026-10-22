// SPDX-License-Identifier: Apache-2.0
// TCP-9100 执行器纯 Dart 直测：起本地 ServerSocket 充当打印机端点，
// 断言写入字节依序送达、flush 语义与断开状态（零平台通道依赖）。

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:taprint_channel_flutter/print_executor.dart';
import 'package:taprint_channel_flutter/tcp9100_executor.dart';

void main() {
  test('connect/writeBytes/disconnect：字节依序送达端点，断开后未连接',
      () async {
    final received = <int>[];
    final done = Completer<void>();
    final server = await ServerSocket.bind('127.0.0.1', 0);
    final serverSub = server.listen((socket) {
      socket.listen((List<int> data) {
        received.addAll(data);
        if (received.length >= 5 && !done.isCompleted) done.complete();
      });
    });

    final executor = Tcp9100Executor();
    await executor.connect(PrintDevice(
      id: 'tcp1',
      name: '网口打印机',
      transport: PrinterTransport.tcp9100,
      host: '127.0.0.1',
      port: server.port,
    ));
    expect(executor.isConnected, isTrue);

    await executor.writeBytes(Uint8List.fromList([0x1B, 0x40, 0x01]));
    await executor.writeBytes(Uint8List.fromList([0x04, 0x05]));
    await done.future.timeout(const Duration(seconds: 5));
    expect(received, [0x1B, 0x40, 0x01, 0x04, 0x05]);

    await executor.disconnect();
    expect(executor.isConnected, isFalse);

    await serverSub.cancel();
    await server.close();
  });

  test('缺少 host / 未连接即写 → StateError', () async {
    final executor = Tcp9100Executor();
    expect(
      () => executor.connect(PrintDevice(
        id: 'tcp2',
        name: '无主机',
        transport: PrinterTransport.tcp9100,
      )),
      throwsStateError,
    );
    expect(() => executor.writeBytes(Uint8List(0)), throwsStateError);
  });
}
