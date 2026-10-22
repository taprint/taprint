// SPDX-License-Identifier: Apache-2.0
// PrintDevice 最小模型：序列化往返与 copyWith 语义。

import 'package:flutter_test/flutter_test.dart';
import 'package:taprint_channel_flutter/print_executor.dart';

void main() {
  test('toJson/fromJson 往返：可选字段缺省（address-only）', () {
    const d = PrintDevice(
      id: 'p1',
      name: '标签机',
      transport: PrinterTransport.ble,
      address: 'AA:BB:CC:DD:EE:FF',
    );
    final round = PrintDevice.fromJson(d.toJson());
    expect(round.id, 'p1');
    expect(round.name, '标签机');
    expect(round.transport, PrinterTransport.ble);
    expect(round.address, 'AA:BB:CC:DD:EE:FF');
    expect(round.host, isNull);
    expect(round.port, 9100);
    expect(round.bleServiceUuid, isNull);
    expect(round.bleCharUuid, isNull);
    expect(d.toJson().containsKey('host'), isFalse,
        reason: '空可选字段不落序列化');
  });

  test('toJson/fromJson 往返：全字段', () {
    const d = PrintDevice(
      id: 'p2',
      name: '网口机',
      transport: PrinterTransport.tcp9100,
      host: '192.0.2.10', // RFC 5737 文档地址段
      port: 9100,
      bleServiceUuid: '0000ff00-0000-1000-8000-00805f9b34fb',
      bleCharUuid: '0000ff01-0000-1000-8000-00805f9b34fb',
    );
    final round = PrintDevice.fromJson(d.toJson());
    expect(round.host, '192.0.2.10');
    expect(round.port, 9100);
    expect(round.bleServiceUuid, d.bleServiceUuid);
    expect(round.bleCharUuid, d.bleCharUuid);
    expect(round.transport, PrinterTransport.tcp9100);
  });

  test('fromJson 兜底：未知传输名回退 ble，端口缺省 9100', () {
    final d = PrintDevice.fromJson({
      'id': 'p3',
      'name': '旧记录',
      'transport': 'carrier-pigeon',
    });
    expect(d.transport, PrinterTransport.ble);
    expect(d.port, 9100);
  });

  test('copyWith：只覆盖给定字段，其余保持', () {
    const base = PrintDevice(
      id: 'p4',
      name: 'old',
      transport: PrinterTransport.spp,
      address: 'AA:00:00:00:00:01',
    );
    final next = base.copyWith(name: 'new', host: '192.0.2.20', port: 9101);
    expect(next.name, 'new');
    expect(next.host, '192.0.2.20');
    expect(next.port, 9101);
    expect(next.address, 'AA:00:00:00:00:01', reason: '未指定字段原样保留');
    expect(next.transport, PrinterTransport.spp);
    expect(next.id, 'p4', reason: 'id 不可变');
  });
}
