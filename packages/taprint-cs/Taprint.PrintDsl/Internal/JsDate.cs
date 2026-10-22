// SPDX-License-Identifier: Apache-2.0
// JS Date C# 端建模：用 long UtcMs 内部表示 + proleptic Gregorian 算法
// （Howard Hinnant civil_from_days / days_from_civil），绕过 DateTimeOffset 最小年 1 限制——
// 支持 V8 真值 year=0（"0000-01-01" 合法）。
// 多语言实现一致性：date 过滤器输出与 TS 端 new Date(v) | date:'fmt' 在 TZ=UTC 下逐字一致
// （一致性验证约定 TZ=UTC；生产环境按系统本地时区 TimeZoneInfo.Local）。
// 字段访问按 V8 语义：getFullYear/getMonth 等用「系统本地时区」（TZ=UTC 即 UTC），
// 与输入字符串自带 offset 时区无关——offset 仅用于算 UtcMs（绝对 UTC 时间）。
// 算法来源：https://howardhinnant.github.io/date_algorithms.html（公网权威，未引入新依赖）。
namespace Taprint.PrintDsl.Internal
{
    internal readonly struct JsDate
    {
        /// <summary>UTC 毫秒数（unix epoch 1970-01-01 起算，可为负代表 proleptic 早于 1970）。</summary>
        public long UtcMs { get; }

        /// <summary>V8 Invalid Date 建模（数值 ms 超 ±8.64e15 范围；字符串解析失败走 ToDate null → ''，不经此）。</summary>
        public bool IsValid { get; }

        public static JsDate Invalid => new JsDate(0, false);

        public JsDate(long utcMs) : this(utcMs, true) { }

        private JsDate(long utcMs, bool isValid)
        {
            UtcMs = utcMs;
            IsValid = isValid;
        }

        /// <summary>从「本地字段（年/月/日/时/分/秒/毫秒）+ 该本地时间相对 UTC 的偏移」构造；
        /// UtcMs 由「本地时刻 - offset」算出（与 V8 new Date(y,m,d,h,...) + DST 本地化语义一致）。</summary>
        public static JsDate FromLocal(int year, int month, int day, int hour, int minute, int second, int millis, short offsetMinutes)
        {
            long days = DaysFromCivil(year, month, day);
            long localMs = days * 86_400_000L + hour * 3_600_000L + minute * 60_000L + second * 1_000L + millis;
            long utcMs = localMs - offsetMinutes * 60_000L;
            return new JsDate(utcMs);
        }

        /// <summary>新增/减去指定天数（日溢出进位：day>当月天数时先 FromLocal(y,m,1,...) 再 WithAddedDays(day-1)）。</summary>
        public JsDate WithAddedDays(long days) => new JsDate(UtcMs + days * 86_400_000L);

        /// <summary>解出本地字段（按 V8 getFullYear/getMonth 等语义：本地字段 = UtcMs + 系统本地时区 offset）。
        /// 调用方传系统本地 offset（TZ=UTC 为 0）；DST 不考虑（V8 同口径）。</summary>
        public void DeconstructLocal(short localOffsetMinutes, out int year, out int month, out int day, out int hour, out int minute, out int second, out int millis)
        {
            var localMs = UtcMs + localOffsetMinutes * 60_000L;
            DeconstructUtc(localMs, out year, out month, out day, out hour, out minute, out second, out millis);
        }

        /// <summary>解出 UTC 字段（按任意 ms 数算 proleptic Gregorian 年/月/日/时/分/秒/毫秒）。</summary>
        public static void DeconstructUtc(long ms, out int year, out int month, out int day, out int hour, out int minute, out int second, out int millis)
        {
            // 向下取整除法（处理负 ms）：等价 Math.floor(ms / 86400000)
            long days = ms >= 0 ? ms / 86_400_000L : (ms - 86_399_999L) / 86_400_000L;
            long remMs = ms - days * 86_400_000L;
            CivilFromDays(days, out year, out month, out day);
            hour = (int)(remMs / 3_600_000L);
            remMs -= hour * 3_600_000L;
            minute = (int)(remMs / 60_000L);
            remMs -= minute * 60_000L;
            second = (int)(remMs / 1_000L);
            millis = (int)(remMs - second * 1_000L);
        }

        // Howard Hinnant days_from_civil（proleptic Gregorian，支持任意年份含 0/负年份）。
        // 入参 y/m/d 为「年（含 0=公元前1年）」+「月（1-12）」+「日（≥1）」；返回 1970-01-01 起的天数（可负）。
        private static long DaysFromCivil(int y, int m, int d)
        {
            y -= m <= 2 ? 1 : 0;
            long era = (y >= 0 ? (long)y : y - 399) / 400;
            long yoe = y - era * 400;
            long doy = (153L * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
            long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
            return era * 146097 + doe - 719468;
        }

        // Howard Hinnant civil_from_days（DaysFromCivil 反向，proleptic Gregorian）。
        private static void CivilFromDays(long z, out int year, out int month, out int day)
        {
            z += 719468;
            long era = z >= 0 ? z : z - 146096;
            era /= 146097;
            long doe = z - era * 146097;
            long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
            int y = (int)(yoe + era * 400);
            long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            long mp = (5 * doy + 2) / 153;
            int d = (int)(doy - (153 * mp + 2) / 5 + 1);
            int m = (int)(mp + (mp < 10 ? 3 : -9));
            year = m <= 2 ? y + 1 : y;
            month = m;
            day = d;
        }
    }
}
