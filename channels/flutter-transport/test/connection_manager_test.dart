// SPDX-License-Identifier: Apache-2.0
// 连接管理器纯逻辑单测：六态迁移、退避序列、断连重连、无线电锁、
// 慢速重连与 retry。全部经注入假执行器 + 注入事件流驱动，零平台
// 通道依赖（连接管理器本身不 import 任何平台插件）。
//
// 退避时序说明：为避免真实等待 1+2+4+8+16s，用 [0,0,0,0,0] 注入
// 驱动「次数与顺序」；默认序列值本身由契约测试锚定
// （defaultBackoffSeconds == [1,2,4,8,16]）。

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:taprint_channel_flutter/connection_manager.dart';
import 'package:taprint_channel_flutter/print_executor.dart';

const _deviceAddr = 'AA:BB:CC:DD:EE:FF';

const _device = PrintDevice(
  id: 'p1',
  name: '测试打印机',
  transport: PrinterTransport.spp,
  address: _deviceAddr,
);

/// 假执行器：[outcomes] 按连接调用次序消费——null/耗尽 = 成功，
/// 非 null = 抛该异常；记录调用计数供断言。
class _FakeExecutor implements PrintExecutor {
  _FakeExecutor(this.outcomes);

  final List<Object?> outcomes;

  int connectCalls = 0;
  int disconnectCalls = 0;
  bool connected = false;

  @override
  bool get isConnected => connected;

  @override
  Future<void> connect(PrintDevice device) async {
    connectCalls++;
    if (connectCalls <= outcomes.length) {
      final outcome = outcomes[connectCalls - 1];
      if (outcome != null) throw outcome;
    }
    connected = true;
  }

  @override
  Future<void> writeBytes(Uint8List bytes) async {}

  @override
  Future<void> disconnect() async {
    disconnectCalls++;
    connected = false;
  }
}

void main() {
  test('退避契约：默认序列 1/2/4/8/16，快速 5 次，慢速 15s', () {
    expect(ConnectionManager.defaultBackoffSeconds, const [1, 2, 4, 8, 16]);
    expect(ConnectionManager.maxReconnectAttempts, 5);
    expect(
      ConnectionManager.slowReconnectInterval,
      const Duration(seconds: 15),
    );
  });

  test('连接成功：disconnected → connecting → connected；手动断开复位', () async {
    final exec = _FakeExecutor(const []);
    final recorded = <PrinterConnectionState>[];
    final m = ConnectionManager(executorFactory: (_) => exec);
    final sub = m.stateStream.listen(recorded.add);
    await m.connect(_device);
    expect(m.state, PrinterConnectionState.connected);
    // BehaviorSubject：新订阅者先拿到当前态（disconnected 种子）。
    expect(recorded, [
      PrinterConnectionState.disconnected,
      PrinterConnectionState.connecting,
      PrinterConnectionState.connected,
    ]);
    expect(exec.connectCalls, 1);

    await m.disconnect();
    expect(m.state, PrinterConnectionState.disconnected);
    expect(exec.disconnectCalls, 1);
    expect(m.currentDevice, isNull);

    await sub.cancel();
    m.dispose();
  });

  test('连续失败：退避期间保持 connecting 不闪 error；耗尽转慢速重连落 error；'
      'retry 重置计数立即重连', () async {
    // 初连 + 5 次退避重连全部失败（第 6 次失败时快速退避已耗尽）。
    final exec = _FakeExecutor(List.filled(6, StateError('boom')));
    final logs = <String>[];
    final m = ConnectionManager(
      executorFactory: (_) => exec,
      backoffSeconds: const [0, 0, 0, 0, 0],
      logger: logs.add,
    );
    await m.connect(_device);
    expect(
      m.state,
      PrinterConnectionState.connecting,
      reason: '退避等待期间状态保持 connecting（「重连中」）',
    );

    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(exec.connectCalls, 6, reason: '初连 1 次 + 快速退避 5 次');
    expect(m.state, PrinterConnectionState.error, reason: '快速退避耗尽');

    final scheduled =
        logs.where((l) => l.contains('reconnect scheduled')).toList();
    expect(scheduled.length, 5);
    expect(scheduled.first, contains('attempt 1/5'));
    expect(scheduled[1], contains('attempt 2/5'));
    expect(scheduled[4], contains('attempt 5/5'));
    expect(logs.any((l) => l.contains('slow reconnect')), isTrue);

    // outcomes 队列已耗尽 → 成功：用户点「重试」立即重连成功。
    await m.retry();
    expect(m.state, PrinterConnectionState.connected);
    expect(exec.connectCalls, 7);

    m.dispose();
  });

  test('意外断连事件：当前设备触发自动重连，无关设备忽略', () async {
    final exec = _FakeExecutor([StateError('link lost')]); // 首连失败一次
    final disconnects = StreamController<TransportDisconnect>.broadcast();
    final m = ConnectionManager(
      executorFactory: (_) => exec,
      disconnectEvents: disconnects.stream,
      backoffSeconds: const [0, 0, 0, 0, 0],
    );
    await m.connect(_device); // 失败 → 0s 退避
    await Future<void>.delayed(const Duration(milliseconds: 100)); // 重连成功
    expect(m.state, PrinterConnectionState.connected);
    expect(exec.connectCalls, 2);

    // 无关设备断连：过滤忽略，状态与调用数不变。
    disconnects.add(const TransportDisconnect('other-device'));
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(m.state, PrinterConnectionState.connected);
    expect(exec.connectCalls, 2);

    // 当前设备断连：自动重连并成功。
    disconnects.add(const TransportDisconnect(_deviceAddr));
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(m.state, PrinterConnectionState.connected);
    expect(exec.connectCalls, 3);

    await disconnects.close();
    m.dispose();
  });

  test('无线电不可用：暂停重连回 disconnected 不闪 error；'
      '回 ready 自动重连一次', () async {
    final exec = _FakeExecutor(const []);
    final radio = StreamController<RadioStatus>.broadcast();
    final m = ConnectionManager(
      executorFactory: (_) => exec,
      radioStatusStream: radio.stream,
      backoffSeconds: const [0, 0, 0, 0, 0],
    );
    await m.connect(_device);
    expect(m.state, PrinterConnectionState.connected);

    radio.add(RadioStatus.unavailable);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(
      m.state,
      PrinterConnectionState.disconnected,
      reason: '蓝牙关：不重连、状态回未连接（等用户开蓝牙）',
    );

    radio.add(RadioStatus.ready);
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(m.state, PrinterConnectionState.connected);
    expect(
      exec.connectCalls,
      2,
      reason: '回 ready 自动重连一次，不耗退避计数',
    );

    await radio.close();
    m.dispose();
  });

  test('markPrinting/markIdle：connected ↔ printing；executor 仅连接态可取', () async {
    final exec = _FakeExecutor(const []);
    final m = ConnectionManager(executorFactory: (_) => exec);
    await m.connect(_device);

    expect(m.executor, exec);
    m.markPrinting();
    expect(m.state, PrinterConnectionState.printing);
    expect(m.executor, exec, reason: 'printing 态仍可写字节流');

    m.markIdle();
    expect(m.state, PrinterConnectionState.connected);
    m.markIdle(); // 非 printing 态 no-op
    expect(m.state, PrinterConnectionState.connected);

    await m.disconnect();
    expect(m.executor, isNull);
    m.dispose();
  });
}
