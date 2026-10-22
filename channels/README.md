# channels

Reference printer-transport implementations:

- Windows: spooler RAW / TCP / serial channels, automatic Text-Only queue
  creation, USB printer detection (NuGet `Taprint.Channel.Windows`);
- Flutter/Dart: `flutter-transport/` — BLE, Bluetooth SPP and TCP-9100
  executors with a six-state connection manager
  (`taprint_channel_flutter`, path dependency);

**Reference quality:** these packages demonstrate the full path from
compiled bytes to a physical printer. Their APIs evolve independently
from the kernel packages and carry weaker stability guarantees.
