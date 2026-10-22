// SPDX-License-Identifier: Apache-2.0
// 连接管理器：传输无关的六态状态机 + 指数退避自动重连（参考实现）。
//
// - 六态：disconnected | scanning | connecting | connected | printing | error；
// - 断连重连指数退避 1/2/4/8/16s，最多 5 次；退避期间状态保持
//   connecting（「重连中」），不闪 error；快速退避耗尽后转慢速持续
//   重连（15s 间隔、无限，成功即接上），不落 error 终态逼用户重启
//   （error 态 UI 提示「曾失败」，慢速重连成功自动转 connected）；
// - 所有状态迁移发事件流（rxdart BehaviorSubject，新订阅者立即拿到
//   当前态），UI 状态条订阅展示；
// - 平台解耦：断连事件与蓝牙无线电状态由宿主以中性类型注入
//   （[TransportDisconnect] / [RadioStatus]，BLE 映射助手见
//   ble_executor.dart 的 bleDisconnectEvents / radioStatusFromBle），
//   本类不 import 任何平台插件 —— 可在纯 Dart VM 下单测。
// ignore_for_file: prefer_initializing_formals

import 'dart:async';

import 'package:rxdart/rxdart.dart';

import 'print_executor.dart';

/// 中性断连事件：宿主把平台链路丢失事件（如 flutter_reactive_ble 的
/// connectedDeviceStream 中「已断开」事件）映射成本类型后注入
/// [ConnectionManager.disconnectEvents]。SPP/TCP 无平台断连流，
/// 链路丢失靠写失败检测（执行器写失败自置未连接并抛错）。
class TransportDisconnect {
  const TransportDisconnect(this.deviceId);

  /// 断连的外设标识（与 [PrintDevice.address] 同口径比对）。
  final String deviceId;
}

/// 蓝牙无线电状态（宿主从平台状态映射；管理器只区分 ready 与否，
/// 不新增连接状态）。非 ready → 锁重连、状态回 disconnected（不闪
/// error，等用户开蓝牙）；回 ready → 解锁并自动重连一次。
enum RadioStatus { ready, unavailable }

class ConnectionManager {
  ConnectionManager({
    required PrintExecutor Function(PrinterTransport) executorFactory,
    Stream<TransportDisconnect>? disconnectEvents,
    Stream<RadioStatus>? radioStatusStream,
    List<int> backoffSeconds = defaultBackoffSeconds,
    void Function(PrintDevice device)? onConnected,
    TransportLogger? logger,
  })  : _executorFactory = executorFactory,
        _disconnectEvents = disconnectEvents,
        _radioStatusStream = radioStatusStream,
        _backoffSeconds = backoffSeconds,
        _onConnected = onConnected,
        _logger = logger,
        _state = BehaviorSubject<PrinterConnectionState>.seeded(
          PrinterConnectionState.disconnected,
        );

  /// 快速退避序列（秒）：指数 1/2/4/8/16。
  static const List<int> defaultBackoffSeconds = [1, 2, 4, 8, 16];

  /// 快速退避最大尝试次数；耗尽后转 [slowReconnectInterval] 慢速
  /// 持续重连（不放弃）。
  static const int maxReconnectAttempts = 5;

  /// 慢速持续重连间隔。
  static const Duration slowReconnectInterval = Duration(seconds: 15);

  final PrintExecutor Function(PrinterTransport) _executorFactory;

  /// 断连事件源（注入则按当前设备过滤监听；不注入 = 不监听平台断连，
  /// SPP/TCP 场景正常 —— 链路丢失由写失败路径触发重连）。
  final Stream<TransportDisconnect>? _disconnectEvents;

  /// 无线电状态常驻订阅源：注入后监听系统蓝牙开关。不注入 = 不监听
  /// （既有连接行为不变）。
  final Stream<RadioStatus>? _radioStatusStream;
  StreamSubscription<RadioStatus>? _radioStatusWatch;
  bool _bleLocked = false;

  final List<int> _backoffSeconds;
  final BehaviorSubject<PrinterConnectionState> _state;
  final void Function(PrintDevice device)? _onConnected;
  final TransportLogger? _logger;
  Timer? _slowReconnectTimer;
  bool _slowReconnecting = false;

  PrintExecutor? _executor;
  PrintDevice? _device;
  StreamSubscription<TransportDisconnect>? _disconnectWatch;
  int _reconnectAttempts = 0;
  bool _autoReconnectEnabled = true;
  Timer? _reconnectTimer;

  PrinterConnectionState get state => _state.value;

  Stream<PrinterConnectionState> get stateStream => _state.stream;

  PrintDevice? get currentDevice => _device;

  /// 当前连接所用执行器（已连接时供上层直接写字节流）。
  PrintExecutor? get executor =>
      state == PrinterConnectionState.connected ||
              state == PrinterConnectionState.printing
          ? _executor
          : null;

  void _log(String message) => _logger?.call(message);

  void _transition(PrinterConnectionState next) {
    if (!_state.isClosed && _state.value != next) {
      _log('state ${_state.value.name} -> ${next.name}');
      _state.add(next);
    }
  }

  /// 连接设备（由设备选择器或默认设备触发）。
  Future<void> connect(PrintDevice device) async {
    _reconnectTimer?.cancel();
    _reconnectAttempts = 0;
    _device = device;
    _executor = _executorFactory(device.transport);
    _ensureRadioStatusWatch();
    await _doConnect(device);
  }

  Future<void> _doConnect(PrintDevice device) async {
    _transition(PrinterConnectionState.connecting);
    try {
      await _executor!.connect(device);
      _transition(PrinterConnectionState.connected);
      _reconnectAttempts = 0;
      // 连接成功回调：所有连接路径（手动 / 自动重连 / 恢复重连）
      // 统一在此通知宿主（典型用途：持久化最后连接设备）。
      _onConnected?.call(device);
      _watchDisconnect(device);
    } catch (e) {
      _log('connect attempt failed: $e');
      _scheduleReconnectOrError();
    }
  }

  /// 监听断连事件源，触发自动重连（按当前设备 address 过滤）。
  void _watchDisconnect(PrintDevice device) {
    _disconnectWatch?.cancel();
    final events = _disconnectEvents;
    if (events == null) return;
    _disconnectWatch = events
        .where((e) => e.deviceId == device.address)
        .listen((_) => _onUnexpectedDisconnect());
  }

  void _onUnexpectedDisconnect() {
    if (state == PrinterConnectionState.disconnected) return;
    _log('unexpected disconnect');
    _scheduleReconnectOrError();
  }

  void _scheduleReconnectOrError() {
    final device = _device;
    if (!_autoReconnectEnabled || device == null || _executor == null) {
      _transition(PrinterConnectionState.error);
      return;
    }
    if (_reconnectAttempts >= maxReconnectAttempts) {
      // 快速退避耗尽：转慢速持续重连（15s 间隔、无限），设备恢复
      // 供电/回到范围后自动接上。
      _enterSlowReconnect(device);
      return;
    }
    if (_bleLocked) {
      // 蓝牙关：不重连不耗重试计数，等用户开蓝牙。状态保持
      // disconnected（UI 显示「未连接」），不闪 error。
      _transition(PrinterConnectionState.disconnected);
      return;
    }
    // 退避期间保持 connecting（「重连中」），避免 UI 闪「连接错误」。
    _transition(PrinterConnectionState.connecting);
    final delay = Duration(seconds: _backoffSeconds[_reconnectAttempts]);
    _log('reconnect scheduled: attempt ${_reconnectAttempts + 1}/'
        '$maxReconnectAttempts in ${delay.inSeconds}s');
    _reconnectAttempts++;
    _reconnectTimer?.cancel();
    // 重连前先断开清理旧 GATT 会话：意外断连路径残留旧 connection
    // stream / Android GATT 资源时，直接重连会连环失败（经典
    // status 133）。清理放在退避延迟之后执行，时序＝
    // [退避等待] → [断开清理] → [重连]，不给蓝牙栈加额外延迟。
    _reconnectTimer = Timer(delay, () {
      unawaited(() async {
        try {
          await _executor?.disconnect();
        } catch (_) {}
        await _doConnect(device);
      }());
    });
  }

  /// 监听无线电状态流：
  /// - unavailable → 锁重连（_bleLocked），触发断开提示，停止重连；
  /// - ready → 解锁，若设备仍在记录中则触发一次自动重连（不增加
  ///   重试计数）。不新增连接状态：六态保留，仅影响迁移决策。
  void _ensureRadioStatusWatch() {
    if (_radioStatusStream == null) return;
    _radioStatusWatch ??= _radioStatusStream.listen((status) {
      if (status == RadioStatus.ready) {
        if (_bleLocked) {
          _bleLocked = false;
          _log('radio ready; auto reconnect');
          final device = _device;
          if (device != null && _executor != null && _autoReconnectEnabled) {
            _reconnectTimer?.cancel();
            _reconnectAttempts = 0;
            unawaited(_doConnect(device));
          }
        }
      } else {
        if (!_bleLocked && _device != null) {
          _bleLocked = true;
          _log('radio unavailable; reconnect paused');
          _reconnectTimer?.cancel();
          _transition(PrinterConnectionState.disconnected);
        }
      }
    });
  }

  /// 用户在 error 态点「重试」：重置计数立即重连。
  Future<void> retry() async {
    if (_device == null || _executor == null) return;
    _slowReconnecting = false;
    _slowReconnectTimer?.cancel();
    _reconnectAttempts = 0;
    await _doConnect(_device!);
  }

  /// 慢速持续重连：快速退避耗尽后不永久放弃 —— 每 15s 静默重试一次
  /// 直到成功（设备恢复供电/回到范围自动接上）或用户手动断开。
  /// 任一次成功即转 connected 并停表。
  void _enterSlowReconnect(PrintDevice device) {
    _slowReconnecting = true;
    // UI 明示曾失败（error 条），但后台持续重试。
    _transition(PrinterConnectionState.error);
    _log('fast backoff exhausted; slow reconnect every '
        '${slowReconnectInterval.inSeconds}s');
    _slowReconnectTimer?.cancel();
    _slowReconnectTimer = Timer.periodic(slowReconnectInterval, (_) {
      if (_slowReconnecting && _device != null) {
        unawaited(_doConnect(device));
      }
    });
  }

  void markPrinting() {
    if (state == PrinterConnectionState.connected) {
      _transition(PrinterConnectionState.printing);
    }
  }

  void markIdle() {
    if (state == PrinterConnectionState.printing) {
      _transition(PrinterConnectionState.connected);
    }
  }

  Future<void> disconnect() async {
    _autoReconnectEnabled = false;
    _reconnectTimer?.cancel();
    _slowReconnectTimer?.cancel();
    _slowReconnecting = false;
    await _disconnectWatch?.cancel();
    _disconnectWatch = null;
    await _executor?.disconnect();
    _executor = null;
    _device = null;
    _transition(PrinterConnectionState.disconnected);
    _autoReconnectEnabled = true;
  }

  void dispose() {
    _reconnectTimer?.cancel();
    _slowReconnectTimer?.cancel();
    _disconnectWatch?.cancel();
    _radioStatusWatch?.cancel();
    _state.close();
  }
}
