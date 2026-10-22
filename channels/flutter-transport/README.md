# taprint_channel_flutter (flutter-transport)

Reference Flutter transport channels for [taprint]: BLE (GATT), Android
Bluetooth SPP and network TCP-9100 executors, plus a six-state connection
manager with exponential-backoff auto-reconnect.

> **Reference implementation.** These packages demonstrate the full path
> from compiled bytes to a physical printer. Their APIs evolve
> independently from the kernel packages (`taprint` / `taprint-ts` /
> `taprint-cs` / `taprint-java`) and carry **weaker stability
> guarantees**: breaking changes may land in `0.x` releases without a
> major bump. Pin the version you tested against.

## What's inside

| File | Role | Dependencies |
| --- | --- | --- |
| `lib/print_executor.dart` | `PrintExecutor` contract, `PrintDevice`, transport & six-state enums | pure Dart |
| `lib/tcp9100_executor.dart` | Raw TCP-9100 socket channel | `dart:io` |
| `lib/ble_executor.dart` | BLE GATT channel (scan / connect / MTU / chunked writes) | `flutter_reactive_ble` ^5.5.0 |
| `lib/spp_executor.dart` | Android SPP / RFCOMM bridge | `flutter/services` + host-side Kotlin |
| `lib/connection_manager.dart` | Six-state machine + backoff reconnect | pure Dart + `rxdart` |
| `lib/executor_factory.dart` | Default transport-to-executor routing | all of the above |
| `android/.../SppChannel.kt` | Native RFCOMM `MethodChannel` handler (Android only) | Kotlin, Flutter embedding |

## Install

The package is consumed from this repository (path or git dependency); it
is not published to pub.dev:

```yaml
dependencies:
  taprint_channel_flutter:
    path: ../channels/flutter-transport
```

Run tests with a Flutter SDK (the pure-logic tests need no device):

```sh
cd channels/flutter-transport && flutter test
```

## TCP-9100 (network printer)

```dart
import 'package:taprint_channel_flutter/taprint_channel_flutter.dart';

final executor = Tcp9100Executor();               // 5 s connect timeout
await executor.connect(PrintDevice(
  id: 'net-1', name: 'Cashier LAN', transport: PrinterTransport.tcp9100,
  host: '192.0.2.10', port: 9100,
));
await executor.writeBytes(bytes);                 // raw bytes, flushed
await executor.disconnect();
```

## BLE (GATT printer)

No vendor pre-filtering on scan, no hard-coded UUIDs: after connecting,
the first writable characteristic is matched heuristically and reported
back through `onBleUuidsResolved` so the host can persist it (next
connect skips the heuristic). Writes are chunked to `MTU - 3`
(floor 20) with a 20 ms inter-chunk delay for `withoutResponse`
characteristics to avoid printer-side buffer overruns.

```dart
final ble = BleExecutor(
  onBleUuidsResolved: (deviceId, serviceUuid, charUuid) {
    // persist to your device record
  },
);
final found = await ble.scan(timeout: const Duration(seconds: 12)).toList();
await ble.connect(device);
await ble.writeBytes(bytes);
await ble.disconnect();
```

## SPP (Android Bluetooth serial)

Dart side is a thin `MethodChannel` bridge; the RFCOMM work lives in
`android/src/main/kotlin/dev/taprint/channel_flutter/SppChannel.kt`
(single-thread IO executor, `cancelDiscovery` before connect, SPP UUID
`00001101-0000-1000-8000-00805F9B34FB`). No Gradle files ship with the
package — the host app owns the build. Drop the Kotlin file into your
Android module and register the channel on the engine:

```kotlin
// in your MainActivity.configureFlutterEngine(...)
SppChannel(this, flutterEngine.dartExecutor.binaryMessenger).register()
```

Manifest side (runtime grant on Android 12+ handled by your permission
flow, see `PERMISSION_DENIED` in the Kotlin source):

```xml
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
```

```dart
final spp = SppExecutor();                          // 10 s RFCOMM timeout
await spp.connect(device);                          // device.address = MAC
await spp.writeBytes(bytes);
await spp.disconnect();
```

## Connection manager (six states + backoff)

`ConnectionManager` drives one device through
`disconnected | scanning | connecting | connected | printing | error`
and auto-reconnects with exponential backoff **1/2/4/8/16 s, at most 5
fast attempts** — during backoff the state stays `connecting` ("reconnecting"),
never flashing `error`. When fast attempts are exhausted it does not give
up: a slow reconnect fires every 15 s until the printer comes back, with
the state surface showing `error` meanwhile. A radio-off lock pauses
reconnecting entirely (state back to `disconnected`) until the adapter is
ready again.

The manager is platform-agnostic on purpose: disconnect events and
Bluetooth radio status are injected as neutral streams. For BLE, wire the
helpers from `ble_executor.dart`:

```dart
final ble = FlutterReactiveBle();
final manager = ConnectionManager(
  executorFactory: createExecutor,
  disconnectEvents: bleDisconnectEvents(ble),
  radioStatusStream: ble.statusStream.map(radioStatusFromBle),
  logger: (line) => debugPrint('[taprint] $line'),
);
manager.stateStream.listen((s) => // banner / status bar
    debugPrint('printer: ${s.name}'));

await manager.connect(device);
manager.markPrinting();
await manager.executor?.writeBytes(bytes);
manager.markIdle();

await manager.disconnect();                        // stops auto-reconnect
manager.dispose();                                 // when the page dies
```

SPP / TCP setups simply omit `disconnectEvents` (link loss is detected
on write failures, per the executor contract).

## Combining with the kernel encoders

Encode with the taprint Dart kernel, then push the bytes through any
executor — that is the whole pipeline:

```dart
import 'package:taprint/printers.dart';            // kernel (DSL + encoders)
import 'package:taprint_channel_flutter/taprint_channel_flutter.dart';

final template = DslParser.parse(receiptTemplateJson);
final bytes = EscposEncoder(widthCols: 32).encode(template, orderData);

final executor = Tcp9100Executor();
await executor.connect(device);
await executor.writeBytes(bytes);
await executor.disconnect();
```

## Testing notes

`test/` runs without an emulator: the connection-manager suite drives
the state machine with a fake executor and injected streams (backoff
cadence injected as zeros; the default `1/2/4/8/16` schedule is pinned
as a contract constant), and the TCP suite talks to a local
`ServerSocket`. BLE/SPP platform behaviour is not covered here.

## License

Apache-2.0 (see repository root `LICENSE`). `flutter_reactive_ble` is
BSD-3.

[taprint]: ../../README.md
