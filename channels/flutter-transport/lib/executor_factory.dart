// SPDX-License-Identifier: Apache-2.0
/// 默认执行器路由：按设备记录的传输方式新建执行器（传输方式来自
/// 设备记录，调用方不推断）。
library;

import 'ble_executor.dart';
import 'print_executor.dart';
import 'spp_executor.dart';
import 'tcp9100_executor.dart';

/// 参考装配：ble → [BleExecutor]（flutter_reactive_ble 同时覆盖
/// Android 与 iOS；宿主若偏好原生 CoreBluetooth 桥，自行注入
/// executorFactory 即可）、spp → [SppExecutor]（需宿主接好原生
/// SppChannel.kt）、tcp9100 → [Tcp9100Executor]。
PrintExecutor createExecutor(PrinterTransport transport) {
  switch (transport) {
    case PrinterTransport.ble:
      return BleExecutor();
    case PrinterTransport.spp:
      return SppExecutor();
    case PrinterTransport.tcp9100:
      return Tcp9100Executor();
  }
}
