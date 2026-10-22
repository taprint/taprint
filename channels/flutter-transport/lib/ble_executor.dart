// SPDX-License-Identifier: Apache-2.0
// BLE 执行器（flutter_reactive_ble，BSD-3）。
//
// 关键规则：
// - 扫描**不预过滤厂商**（withServices 传空列表），picker 全量展示；
// - 不硬编码 UUID：连接后启发式匹配可写特征值；
// - 首次连接成功后把 service/characteristic UUID 经
//   [BleExecutor.onBleUuidsResolved] 回调宿主（宿主持久化到设备记录），
//   下次直连跳过启发式匹配；
// - withoutResponse 分片间做流控延迟（默认 20ms/片），防仅支持
//   withoutResponse 的机型缓冲区溢出/丢字节；withResponse 的可靠性
//   由协议 ACK 保证，不加延迟。
// ignore_for_file: prefer_initializing_formals

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_reactive_ble/flutter_reactive_ble.dart';

import 'connection_manager.dart';
import 'print_executor.dart';

class BleExecutor implements PrintExecutor {
  BleExecutor({
    FlutterReactiveBle? ble,
    this.onBleUuidsResolved,
    Duration flowControlDelay = const Duration(milliseconds: 20),
    TransportLogger? logger,
  })  : _ble = ble ?? FlutterReactiveBle(),
        _flowControlDelay = flowControlDelay,
        _logger = logger;

  final FlutterReactiveBle _ble;

  /// UUID 回写回调（宿主持久化侧入口，签名：
  /// 设备记录 id + service UUID + characteristic UUID）。不注入时
  /// 启发式匹配仍正常工作，只是下次连接重复匹配一遍。
  final void Function(String deviceId, String serviceUuid, String charUuid)?
      onBleUuidsResolved;

  /// withoutResponse 分片间流控延迟：20ms/片。
  final Duration _flowControlDelay;
  final TransportLogger? _logger;

  String? _deviceId;
  Characteristic? _writeChar;
  int _mtu = 23;

  /// 持有连接流订阅：flutter_reactive_ble 中取消订阅即断开连接。
  StreamSubscription<ConnectionStateUpdate>? _connectionSub;

  @override
  bool get isConnected => _deviceId != null && _writeChar != null;

  /// 扫描（不预过滤厂商）。[timeout] 到点自动关流。
  Stream<DiscoveredDevice> scan({
    Duration timeout = const Duration(seconds: 12),
  }) {
    late final StreamController<DiscoveredDevice> controller;
    StreamSubscription<DiscoveredDevice>? sub;
    Timer? timer;
    controller = StreamController<DiscoveredDevice>(
      onListen: () {
        sub = _ble
            .scanForDevices(withServices: const [])
            .listen(controller.add, onError: controller.addError);
        timer = Timer(timeout, controller.close);
      },
      onCancel: () async {
        timer?.cancel();
        await sub?.cancel();
      },
    );
    return controller.stream;
  }

  @override
  Future<void> connect(PrintDevice device) async {
    _deviceId = device.address;
    if (_deviceId == null) {
      throw StateError('BLE 设备缺少 address（MAC/identifier）');
    }
    final connected = Completer<void>();
    _connectionSub = _ble
        .connectToDevice(
          id: _deviceId!,
          connectionTimeout: const Duration(seconds: 10),
        )
        .listen((update) {
      if (update.connectionState == DeviceConnectionState.connected &&
          !connected.isCompleted) {
        connected.complete();
      }
      if (update.connectionState == DeviceConnectionState.disconnected &&
          !connected.isCompleted) {
        connected.completeError(StateError('BLE 连接失败：${update.failure}'));
      }
    }, onError: (Object e) {
      if (!connected.isCompleted) connected.completeError(e);
    });
    try {
      await connected.future;
    } catch (e) {
      _logger?.call('ble connect failed: $e');
      await disconnect();
      rethrow;
    }
    // Android 协商 MTU（iOS 忽略，平台插件内部处理）。
    try {
      _mtu = await _ble.requestMtu(deviceId: _deviceId!, mtu: 512);
    } catch (_) {
      _mtu = 23;
    }
    _writeChar = await _resolveWriteCharacteristic(device);
    if (_writeChar == null) {
      await disconnect();
      throw StateError('未找到可写特征值（启发式匹配失败）');
    }
    _logger?.call('ble connected to ${_deviceId}');
  }

  /// 启发式匹配可写特征值：优先设备记录中回写过的 UUID，
  /// 否则取第一个可写（with/without response）特征值。
  Future<Characteristic?> _resolveWriteCharacteristic(
    PrintDevice device,
  ) async {
    final services = await _ble.getDiscoveredServices(_deviceId!);
    final all = services.expand((s) => s.characteristics);
    if (device.bleServiceUuid != null && device.bleCharUuid != null) {
      final cached = all.where(
        (c) =>
            c.id.toString() == device.bleCharUuid &&
            c.service.id.toString() == device.bleServiceUuid,
      );
      if (cached.isNotEmpty) return cached.first;
    }
    final writable = all.where(
      (c) => c.isWritableWithResponse || c.isWritableWithoutResponse,
    );
    if (writable.isEmpty) return null;
    final picked = writable.first;
    onBleUuidsResolved?.call(
      device.id,
      picked.service.id.toString(),
      picked.id.toString(),
    );
    return picked;
  }

  @override
  Future<void> writeBytes(Uint8List bytes) async {
    final char = _writeChar;
    if (char == null) throw StateError('BLE 未连接');
    // 按 MTU 分片（ATT 开销 3 字节，下限 20 保底）。
    final chunkSize = (_mtu - 3).clamp(20, 512);
    final withResponse = char.isWritableWithResponse;
    for (var offset = 0; offset < bytes.length; offset += chunkSize) {
      final end = (offset + chunkSize).clamp(0, bytes.length);
      await char.write(
        bytes.sublist(offset, end),
        withResponse: withResponse,
      );
      if (!withResponse) {
        await Future<void>.delayed(_flowControlDelay);
      }
    }
  }

  @override
  Future<void> disconnect() async {
    await _connectionSub?.cancel();
    _connectionSub = null;
    _deviceId = null;
    _writeChar = null;
  }
}

/// 把 flutter_reactive_ble 的连接状态流映射为中性断连事件流，供
/// [ConnectionManager.disconnectEvents] 注入：只保留「已断开」事件，
/// 并携带 deviceId 供管理器按当前设备过滤。
Stream<TransportDisconnect> bleDisconnectEvents(FlutterReactiveBle ble) =>
    ble.connectedDeviceStream
        .where(
          (u) => u.connectionState == DeviceConnectionState.disconnected,
        )
        .map((u) => TransportDisconnect(u.deviceId));

/// flutter_reactive_ble 的 [BleStatus] → [RadioStatus] 映射（宿主用
/// `ble.statusStream.map(radioStatusFromBle)` 接入管理器的
/// [ConnectionManager.radioStatusStream]）。
RadioStatus radioStatusFromBle(BleStatus status) =>
    status == BleStatus.ready ? RadioStatus.ready : RadioStatus.unavailable;
