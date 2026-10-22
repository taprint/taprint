/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.expression;

import dev.taprint.core.PrintKernelException;
import dev.taprint.core.PrintErrorCode;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Collection;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
  * Filter-pipe implementations (whitelist of 11 filters).
 * <p>缺省值口径与 TS 端对齐：date→'YYYY-MM-DD'、currency→CNY、round→0 位、
 * truncate→20、default→''。币种符号表与 TS 端一致。
 */
public class FilterRegistry {

    private static final Map<String, String> CURRENCY_SYMBOLS = new HashMap<>();
    private static final Set<String> ZERO_DECIMAL_CURRENCIES = new HashSet<>(Arrays.asList("JPY", "KRW"));

    static {
        // CNY 全角 ￥（U+FFE5，GBK A2E3）：半角 ¥ 在小票机大字号/驱动字体下缺字形渲染成「?」
        CURRENCY_SYMBOLS.put("CNY", "￥");
        CURRENCY_SYMBOLS.put("USD", "$");
        CURRENCY_SYMBOLS.put("EUR", "€");
        CURRENCY_SYMBOLS.put("GBP", "£");
        CURRENCY_SYMBOLS.put("JPY", "JP¥");
        CURRENCY_SYMBOLS.put("HKD", "HK$");
        CURRENCY_SYMBOLS.put("KRW", "₩");
        CURRENCY_SYMBOLS.put("TWD", "NT$");
    }

    public Object apply(String name, Object value, List<Object> args) {
        switch (name) {
            case "date":
                return date(value, argString(args, 0, "YYYY-MM-DD"));
            case "currency":
                return currency(value, argString(args, 0, "CNY"));
            case "round":
                return round(value, argInt(args, 0, 0));
            case "sum":
                return aggregate(value, args, "sum");
            case "avg":
                return aggregate(value, args, "avg");
            case "min":
                return aggregate(value, args, "min");
            case "max":
                return aggregate(value, args, "max");
            case "count":
                return count(value);
            case "truncate":
                return truncate(value, argInt(args, 0, 20));
            case "mask":
                return mask(value, argString(args, 0, null));
            case "default":
                return EcmaValue.truthy(value) ? value : (args.isEmpty() ? "" : args.get(0));
            default:
                throw PrintKernelException.builder()
                        .errorCode(PrintErrorCode.EXPRESSION_INVALID)
                        .message("未知过滤器: " + name)
                        .build();
        }
    }

    // ---- date ----

    public String date(Object value, String pattern) {
        Date date = toDate(value);
        if (date == null) {
            return "";
        }
        SimpleDateFormat sdf = new SimpleDateFormat(toJavaPattern(pattern));
        return sdf.format(date);
    }

    private Date toDate(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Date) {
            return (Date) value;
        }
        if (value instanceof Number) {
            return new Date(((Number) value).longValue());
        }
        if (value instanceof String) {
            String s = ((String) value).trim();
            String[] patterns = {"yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd", "yyyy/MM/dd HH:mm:ss", "yyyy/MM/dd"};
            for (String p : patterns) {
                try {
                    return new SimpleDateFormat(p).parse(s);
                } catch (Exception ignore) {
                    // 尝试下一个格式
                }
            }
            return null;
        }
        return null;
    }

    /** DSL 占位符（YYYY-MM-DD HH:mm:ss）→ Java SimpleDateFormat */
    private String toJavaPattern(String pattern) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < pattern.length(); i++) {
            char c = pattern.charAt(i);
            if (pattern.startsWith("YYYY", i)) {
                sb.append("yyyy");
                i += 3;
            } else if (c == 'D' && pattern.startsWith("DD", i)) {
                sb.append("dd");
                i += 1;
            } else {
                // MM/mm/HH/ss 与 Java 一致；其余字符原样（含分隔符）
                sb.append(c);
            }
        }
        return sb.toString();
    }

    // ---- currency ----

    public String currency(Object value, String code) {
        String symbol = CURRENCY_SYMBOLS.getOrDefault(code, code + " ");
        if (!EcmaValue.truthy(value) && !(value instanceof Number)) {
            return symbol + formatAmount(BigDecimal.ZERO, code);
        }
        Object num = EcmaValue.toNumber(value);
        if (EcmaValue.isNaN(num)) {
            return symbol + formatAmount(BigDecimal.ZERO, code);
        }
        BigDecimal amount = EcmaValue.toBigDecimal((Number) num);
        return symbol + formatAmount(amount, code);
    }

    private String formatAmount(BigDecimal amount, String code) {
        int scale = ZERO_DECIMAL_CURRENCIES.contains(code) ? 0 : 2;
        BigDecimal scaled = amount.setScale(scale, RoundingMode.HALF_UP);
        String plain = scaled.toPlainString();
        boolean negative = scaled.signum() < 0;
        String abs = negative ? plain.substring(1) : plain;
        int dot = abs.indexOf('.');
        String intPart = dot >= 0 ? abs.substring(0, dot) : abs;
        String fracPart = dot >= 0 ? abs.substring(dot) : "";
        StringBuilder grouped = new StringBuilder();
        int len = intPart.length();
        for (int i = 0; i < len; i++) {
            if (i > 0 && (len - i) % 3 == 0) {
                grouped.append(',');
            }
            grouped.append(intPart.charAt(i));
        }
        return (negative ? "-" : "") + grouped + fracPart;
    }

    // ---- round ----

    public Object round(Object value, int digits) {
        if (value == null) {
            return null;
        }
        Object num = EcmaValue.toNumber(value);
        if (EcmaValue.isNaN(num)) {
            return Double.NaN;
        }
        BigDecimal bd = EcmaValue.toBigDecimal((Number) num).setScale(digits, RoundingMode.HALF_UP);
        return digits <= 0 ? EcmaValue.toBigDecimal(bd).toBigInteger().longValue() : bd;
    }

    // ---- 聚合 ----

    private Object aggregate(Object value, List<Object> args, String op) {
        if (!(value instanceof Collection)) {
            return "sum".equals(op) ? BigDecimal.ZERO : null;
        }
        Collection<?> list = (Collection<?>) value;
        String field = args.isEmpty() ? null : String.valueOf(args.get(0));
        BigDecimal total = null;
        BigDecimal min = null;
        BigDecimal max = null;
        int n = 0;
        for (Object item : list) {
            Object raw = field == null ? item : extractField(item, field);
            Object num = EcmaValue.toNumber(raw);
            if (EcmaValue.isNaN(num) || num == null) {
                continue;
            }
            BigDecimal bd = EcmaValue.toBigDecimal((Number) num);
            total = total == null ? bd : total.add(bd);
            min = min == null || bd.compareTo(min) < 0 ? bd : min;
            max = max == null || bd.compareTo(max) > 0 ? bd : max;
            n++;
        }
        switch (op) {
            case "sum":
                return total == null ? BigDecimal.ZERO : total;
            case "avg":
                return total == null || n == 0 ? BigDecimal.ZERO
                        : total.divide(BigDecimal.valueOf(n), 10, RoundingMode.HALF_UP).stripTrailingZeros();
            case "min":
                return min;
            case "max":
                return max;
            default:
                return null;
        }
    }

    /** 行内字段提取（支持 a.b 路径） */
    private Object extractField(Object item, String field) {
        Object current = item;
        for (String seg : field.split("\\.")) {
            if (current instanceof Map) {
                Map<?, ?> map = (Map<?, ?>) current;
                current = map.containsKey(seg) ? map.get(seg) : null;
            } else {
                return null;
            }
            if (current == null) {
                return null;
            }
        }
        return current;
    }

    // ---- count / truncate / mask ----

    public int count(Object value) {
        if (value instanceof Collection) {
            return ((Collection<?>) value).size();
        }
        if (value instanceof Map) {
            return ((Map<?, ?>) value).size();
        }
        if (value instanceof String) {
            return ((String) value).length();
        }
        return 0;
    }

    public String truncate(Object value, int maxLen) {
        if (value == null) {
            return "";
        }
        String s = EcmaValue.toDisplayString(value);
        if (s.length() <= maxLen) {
            return s;
        }
        return maxLen <= 3 ? s.substring(0, maxLen) : s.substring(0, maxLen - 3) + "...";
    }

    public String mask(Object value, String pattern) {
        if (value == null) {
            return "";
        }
        String s = EcmaValue.toDisplayString(value);
        if (pattern == null || pattern.isEmpty()) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < s.length(); i++) {
                sb.append('*');
            }
            return sb.toString();
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < pattern.length(); i++) {
            char p = pattern.charAt(i);
            if (p == '*') {
                sb.append('*');
            } else {
                sb.append(i < s.length() ? s.charAt(i) : p);
            }
        }
        return sb.toString();
    }

    private String argString(List<Object> args, int idx, String def) {
        if (args == null || idx >= args.size() || args.get(idx) == null) {
            return def;
        }
        return String.valueOf(args.get(idx));
    }

    private int argInt(List<Object> args, int idx, int def) {
        if (args == null || idx >= args.size() || args.get(idx) == null) {
            return def;
        }
        Object v = args.get(idx);
        if (v instanceof Number) {
            return ((Number) v).intValue();
        }
        try {
            return Integer.parseInt(String.valueOf(v));
        } catch (NumberFormatException e) {
            return def;
        }
    }
}
