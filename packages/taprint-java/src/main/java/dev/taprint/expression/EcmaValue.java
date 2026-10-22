/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.expression;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;

/**
  * JS-flavored value semantics used across the expression engine.
 * <p>真值规则：false/null/0/""/NaN 为假，其余为真；'+' 一侧为字符串即拼接；
 * '==' 宽松相等（boolean 先转数字）；数字运算用 BigDecimal 保精度（JS double 的超集）。
 */
public final class EcmaValue {

    private EcmaValue() {
    }

    public static boolean isNumber(Object v) {
        return v instanceof Number;
    }

    public static boolean isNaN(Object v) {
        return v instanceof Double && ((Double) v).isNaN();
    }

    /** JS 真值判定 */
    public static boolean truthy(Object v) {
        if (v == null || Boolean.FALSE.equals(v)) {
            return false;
        }
        if (v instanceof Boolean) {
            return (Boolean) v;
        }
        if (isNaN(v)) {
            return false;
        }
        if (v instanceof Number) {
            return toBigDecimal((Number) v).signum() != 0;
        }
        if (v instanceof String) {
            return !((String) v).isEmpty();
        }
        return true;
    }

    public static BigDecimal toBigDecimal(Number n) {
        if (n instanceof BigDecimal) {
            return (BigDecimal) n;
        }
        if (n instanceof Integer || n instanceof Long || n instanceof Short || n instanceof Byte) {
            return BigDecimal.valueOf(n.longValue());
        }
        double d = n.doubleValue();
        if (Double.isNaN(d) || Double.isInfinite(d)) {
            return BigDecimal.ZERO;
        }
        return BigDecimal.valueOf(d);
    }

    /** JS ToNumber：boolean→0/1，null→0，string→解析（失败 NaN） */
    public static Object toNumber(Object v) {
        if (v == null) {
            return 0;
        }
        if (v instanceof Boolean) {
            return ((Boolean) v) ? 1 : 0;
        }
        if (v instanceof Number) {
            return v;
        }
        if (v instanceof String) {
            String s = ((String) v).trim();
            if (s.isEmpty()) {
                return 0;
            }
            try {
                if (s.indexOf('.') >= 0) {
                    return Double.parseDouble(s);
                }
                long l = Long.parseLong(s);
                if (l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE) {
                    return (int) l;
                }
                return l;
            } catch (NumberFormatException e) {
                return Double.NaN;
            }
        }
        return Double.NaN;
    }

    /** 插值/展示用字符串：null → 空串（打印场景），数字去无意义尾零 */
    public static String toDisplayString(Object v) {
        if (v == null) {
            return "";
        }
        if (v instanceof BigDecimal) {
            BigDecimal bd = ((BigDecimal) v).stripTrailingZeros();
            return bd.scale() <= 0 ? bd.toPlainString() : bd.toPlainString();
        }
        if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            if (Double.isNaN(d)) {
                return "NaN";
            }
            if (d == Math.rint(d) && !Double.isInfinite(d) && Math.abs(d) < 1e15) {
                return String.valueOf((long) d);
            }
            return String.valueOf(d);
        }
        return String.valueOf(v);
    }

    /** '+'：一侧字符串即拼接，否则数值相加 */
    public static Object add(Object a, Object b) {
        if (a instanceof String || b instanceof String) {
            return toConcatString(a) + toConcatString(b);
        }
        return numericBinary(a, b, '+');
    }

    private static String toConcatString(Object v) {
        if (v == null) {
            return "";
        }
        if (v instanceof Double && ((Double) v).isNaN()) {
            return "NaN";
        }
        return toDisplayString(v);
    }

    public static Object numericBinary(Object a, Object b, char op) {
        Object na = toNumber(a);
        Object nb = toNumber(b);
        if (isNaN(na) || isNaN(nb)) {
            return Double.NaN;
        }
        BigDecimal x = toBigDecimal((Number) na);
        BigDecimal y = toBigDecimal((Number) nb);
        switch (op) {
            case '+':
                return normalize(x.add(y));
            case '-':
                return normalize(x.subtract(y));
            case '*':
                return normalize(x.multiply(y));
            case '/':
                if (y.signum() == 0) {
                    return Double.NaN;
                }
                return normalize(x.divide(y, MathContext.DECIMAL64));
            case '%':
                if (y.signum() == 0) {
                    return Double.NaN;
                }
                return normalize(x.remainder(y));
            default:
                throw new IllegalStateException("未知算术操作: " + op);
        }
    }

    /** 整数结果收敛为 Integer/Long，避免展示 2.0 */
    private static Number normalize(BigDecimal v) {
        try {
            BigDecimal stripped = v.stripTrailingZeros();
            if (stripped.scale() <= 0 && stripped.abs().compareTo(BigDecimal.valueOf(Long.MAX_VALUE)) < 0) {
                long l = stripped.longValueExact();
                if (l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE) {
                    return (int) l;
                }
                return l;
            }
            return v;
        } catch (ArithmeticException e) {
            return v;
        }
    }

    public static Object negate(Object v) {
        Object n = toNumber(v);
        if (isNaN(n)) {
            return Double.NaN;
        }
        return normalize(toBigDecimal((Number) n).negate());
    }

    /** JS '===' 严格相等：数字跨类型按值比较 */
    public static boolean strictEquals(Object a, Object b) {
        if (a == null || b == null) {
            return a == null && b == null;
        }
        if (a instanceof Number && b instanceof Number && !isNaN(a) && !isNaN(b)) {
            return toBigDecimal((Number) a).compareTo(toBigDecimal((Number) b)) == 0;
        }
        if (a instanceof String && b instanceof String) {
            return a.equals(b);
        }
        if (a instanceof Boolean && b instanceof Boolean) {
            return a.equals(b);
        }
        return a.equals(b);
    }

    /** JS '==' 宽松相等：boolean 先转数字；数字 vs 字符串按数值 */
    public static boolean looseEquals(Object a, Object b) {
        if (a == null || b == null) {
            return a == null && b == null;
        }
        if (a instanceof Boolean || b instanceof Boolean) {
            return looseEquals(toNumber(a), toNumber(b));
        }
        if (a instanceof Number && b instanceof String) {
            return looseEquals(a, toNumber(b));
        }
        if (a instanceof String && b instanceof Number) {
            return looseEquals(toNumber(a), b);
        }
        return strictEquals(a, b);
    }

    /**
     * 关系比较（a &lt; b 语义），返回 null 表示 NaN 参与比较（JS 结果为 false）。
     * 字符串双端按字典序，其余按数值。
     */
    public static Boolean lessThan(Object a, Object b) {
        if (a instanceof String && b instanceof String) {
            return ((String) a).compareTo((String) b) < 0;
        }
        Object na = toNumber(a);
        Object nb = toNumber(b);
        if (isNaN(na) || isNaN(nb)) {
            return null;
        }
        return toBigDecimal((Number) na).compareTo(toBigDecimal((Number) nb)) < 0;
    }

    public static int compareNumbers(Object a, Object b) {
        BigDecimal x = toBigDecimal((Number) toNumber(a));
        BigDecimal y = toBigDecimal((Number) toNumber(b));
        return x.compareTo(y);
    }

    /** round 过滤用 */
    public static BigDecimal round(BigDecimal v, int scale) {
        return v.setScale(scale, RoundingMode.HALF_UP);
    }
}
