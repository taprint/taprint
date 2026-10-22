// SPDX-License-Identifier: Apache-2.0
/// taprint_channel_flutter —— taprint 打印传输通道参考实现（Flutter）。
///
/// 三通道执行器（BLE / Android SPP / TCP-9100）+ 六态连接管理器
/// （指数退避 1/2/4/8/16s × 5 次 + 慢速持续重连）。定位是参考实现：
/// API 随内核之外的节奏演进，稳定性承诺弱于内核包。
///
/// 纯逻辑部分（[PrintExecutor] 契约与模型、[ConnectionManager]）
/// 无平台依赖；BLE/SPP 执行器分别依赖 flutter_reactive_ble 与
/// flutter/services。Android SPP 的原生侧见 android/ 目录 SppChannel.kt。
library;

export 'ble_executor.dart';
export 'connection_manager.dart';
export 'executor_factory.dart';
export 'print_executor.dart';
export 'spp_executor.dart';
export 'tcp9100_executor.dart';
