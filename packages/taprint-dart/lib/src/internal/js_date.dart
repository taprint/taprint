// SPDX-License-Identifier: Apache-2.0
// JS Date Dart 端建模（与 C# Internal/JsDate.cs 同构，cope 0.1⑤）：
// long UtcMs 内部表示 + proleptic Gregorian 算法（Howard Hinnant
// civil_from_days / days_from_civil），支持 V8 真值 year=0（"0000-01-01" 合法）。
// 字段访问按 V8 语义：getFullYear/getMonth 等用「系统本地时区」，与输入字符串
// 自带 offset 无关——offset 仅用于算 UtcMs。DST 不考虑（V8 BaseUtcOffset 同口径）。

class JsDate {
  /// UTC 毫秒数（unix epoch 1970-01-01 起算，可为负代表 proleptic 早于 1970）。
  final int utcMs;

  /// V8 Invalid Date 建模（数值 ms 超 ±8.64e15 范围；字符串解析失败走 toDate
  /// null → ''，不经此）。
  final bool isValid;

  static const JsDate invalid = JsDate._(0, false);

  const JsDate(this.utcMs) : isValid = true;

  const JsDate._(this.utcMs, this.isValid);

  /// 从「本地字段（年/月/日/时/分/秒/毫秒）+ 该本地时间相对 UTC 的偏移」构造；
  /// UtcMs 由「本地时刻 - offset」算出（与 V8 new Date(y,m,d,h,...) 语义一致）。
  factory JsDate.fromLocal(
    int year,
    int month,
    int day,
    int hour,
    int minute,
    int second,
    int millis,
    int offsetMinutes,
  ) {
    final days = _daysFromCivil(year, month, day);
    final localMs =
        days * 86400000 + hour * 3600000 + minute * 60000 + second * 1000 + millis;
    return JsDate(localMs - offsetMinutes * 60000);
  }

  /// 新增/减去指定天数（日溢出进位：调用方先 fromLocal(y,m,1,...) 再 withAddedDays(day-1)）。
  JsDate withAddedDays(int days) => JsDate(utcMs + days * 86400000);

  /// 解出本地字段（按 V8 getFullYear/getMonth 等语义：本地字段 = UtcMs + 系统本地
  /// 时区 offset）。调用方传系统本地 offset 分钟数（TZ=UTC 为 0）。
  JsDateFields deconstructLocal(int localOffsetMinutes) =>
      deconstructUtc(utcMs + localOffsetMinutes * 60000);

  /// 解出 UTC 字段（按任意 ms 数算 proleptic Gregorian 年/月/日/时/分/秒/毫秒）。
  static JsDateFields deconstructUtc(int ms) {
    // 向下取整除法（处理负 ms）：等价 Math.floor(ms / 86400000)
    final days = ms >= 0 ? ms ~/ 86400000 : (ms - 86399999) ~/ 86400000;
    var remMs = ms - days * 86400000;
    final civil = _civilFromDays(days);
    final hour = remMs ~/ 3600000;
    remMs -= hour * 3600000;
    final minute = remMs ~/ 60000;
    remMs -= minute * 60000;
    final second = remMs ~/ 1000;
    final millis = remMs - second * 1000;
    return JsDateFields(civil.$1, civil.$2, civil.$3, hour, minute, second, millis);
  }

  // Howard Hinnant days_from_civil（proleptic Gregorian，支持任意年份含 0/负年份）。
  static int _daysFromCivil(int y, int m, int d) {
    y -= m <= 2 ? 1 : 0;
    final era = (y >= 0 ? y : y - 399) ~/ 400;
    final yoe = y - era * 400;
    final doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) ~/ 5 + d - 1;
    final doe = yoe * 365 + yoe ~/ 4 - yoe ~/ 100 + doy;
    return era * 146097 + doe - 719468;
  }

  // Howard Hinnant civil_from_days（daysFromCivil 反向，proleptic Gregorian）。
  static (int, int, int) _civilFromDays(int z0) {
    var z = z0 + 719468;
    var era = z >= 0 ? z : z - 146096;
    era ~/= 146097;
    final doe = z - era * 146097;
    final yoe = (doe - doe ~/ 1460 + doe ~/ 36524 - doe ~/ 146096) ~/ 365;
    final y = yoe + era * 400;
    final doy = doe - (365 * yoe + yoe ~/ 4 - yoe ~/ 100);
    final mp = (5 * doy + 2) ~/ 153;
    final d = doy - (153 * mp + 2) ~/ 5 + 1;
    final m = mp + (mp < 10 ? 3 : -9);
    return (m <= 2 ? y + 1 : y, m, d);
  }
}

class JsDateFields {
  final int year;
  final int month;
  final int day;
  final int hour;
  final int minute;
  final int second;
  final int millis;

  const JsDateFields(
      this.year, this.month, this.day, this.hour, this.minute, this.second, this.millis);
}

/// 系统本地时区偏移（分钟）。TZ=UTC 为 0；TZ=UTC+8 为 480。DST 不考虑。
int localOffsetMinutes() => DateTime.now().timeZoneOffset.inMinutes;
