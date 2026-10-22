// SPDX-License-Identifier: Apache-2.0
/// 打印传输抽象：执行器接口、传输枚举、六态连接状态与最小设备记录。
///
/// 本文件刻意保持**纯 Dart**（无 Flutter / 平台通道依赖），使连接
/// 状态机等纯逻辑可在 Dart VM 上直接做单测；三个具体执行器
/// （BLE / SPP / TCP-9100）与连接管理器见同目录其余文件。
library;

import 'dart:typed_data';

/// 可选日志钩子：宿主注入即得通道层观测点（连接迁移、退避调度、
/// 链路失败等）。不注入 = 静默，行为不变。
typedef TransportLogger = void Function(String message);

/// 传输方式：决定路由到哪个执行器（App 侧按设备记录选择，不推断）。
enum PrinterTransport {
  /// BLE GATT（flutter_reactive_ble）。
  ble,

  /// Android 蓝牙 SPP / RFCOMM（MethodChannel + 原生 BluetoothSocket）。
  spp,

  /// WiFi 网口 9100 端口原始套接字（dart:io）。
  tcp9100,
}

/// 连接状态机六态。
enum PrinterConnectionState {
  disconnected,

  /// 扫描中（由宿主在搜索设备时置入；管理器本身不经由该态迁移）。
  scanning,

  connecting,

  connected,

  printing,

  error,
}

/// 打印设备端点记录（传输层最小集）：只含路由到执行器与建立连接
/// 所需字段，业务属性（方言、模板等）不属于本层，由内核/宿主持有。
class PrintDevice {
  const PrintDevice({
    required this.id,
    required this.name,
    required this.transport,
    this.address,
    this.host,
    this.port = 9100,
    this.bleServiceUuid,
    this.bleCharUuid,
  });

  final String id;
  final String name;
  final PrinterTransport transport;

  /// BLE：外设标识（Android 为 MAC，iOS 为系统分配的 identifier）；
  /// SPP：MAC；TCP：忽略（用 [host]/[port]）。
  final String? address;

  /// TCP 主机（IP 或主机名）；BLE/SPP 忽略。
  final String? host;
  final int port;

  /// 首次 BLE 连接成功后回写缓存的 UUID（宿主持久化），下次直连
  /// 跳过启发式匹配。
  final String? bleServiceUuid;
  final String? bleCharUuid;

  PrintDevice copyWith({
    String? name,
    String? address,
    String? host,
    int? port,
    String? bleServiceUuid,
    String? bleCharUuid,
  }) {
    return PrintDevice(
      id: id,
      name: name ?? this.name,
      transport: transport,
      address: address ?? this.address,
      host: host ?? this.host,
      port: port ?? this.port,
      bleServiceUuid: bleServiceUuid ?? this.bleServiceUuid,
      bleCharUuid: bleCharUuid ?? this.bleCharUuid,
    );
  }

  /// 持久化序列化（宿主自行选择存储；重启后可反序列化做自动重连）。
  Map<String, Object?> toJson() => {
        'id': id,
        'name': name,
        'transport': transport.name,
        if (address != null) 'address': address,
        if (host != null) 'host': host,
        'port': port,
        if (bleServiceUuid != null) 'bleServiceUuid': bleServiceUuid,
        if (bleCharUuid != null) 'bleCharUuid': bleCharUuid,
      };

  static PrintDevice fromJson(Map<String, Object?> json) {
    return PrintDevice(
      id: json['id'] as String,
      name: (json['name'] as String?) ?? '',
      transport: PrinterTransport.values.firstWhere(
        (t) => t.name == json['transport'],
        orElse: () => PrinterTransport.ble,
      ),
      address: json['address'] as String?,
      host: json['host'] as String?,
      port: (json['port'] as num?)?.toInt() ?? 9100,
      bleServiceUuid: json['bleServiceUuid'] as String?,
      bleCharUuid: json['bleCharUuid'] as String?,
    );
  }
}

/// 打印执行器契约：接收已渲染/已编码的字节流并推给打印机。
///
/// 语义约定（三个实现一致）：
/// - 参数缺失 / 未连接即写 → 抛 [StateError]；
/// - 连接失败抛原始异常（[TimeoutException] / 平台异常转 [StateError]）；
/// - 写失败视为链路断：实现须自行置未连接（isConnected=false），
///   由上层连接管理器据此重连。
abstract class PrintExecutor {
  Future<void> connect(PrintDevice device);

  Future<void> writeBytes(Uint8List bytes);

  Future<void> disconnect();

  bool get isConnected;
}
