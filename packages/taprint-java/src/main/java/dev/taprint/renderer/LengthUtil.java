/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

/**
 * DSL length 单位换算（schema：mm/cm/pt/px，mm 为主单位）。
 *
 * <p>pt = 25.4/72 mm；px 按 96dpi = 25.4/96 mm。标签机按 203dpi（8 dot/mm）换算点阵坐标。
 */
public final class LengthUtil {

    public static final int LABEL_DPI = 203;
    public static final double DOTS_PER_MM = LABEL_DPI / 25.4d;

    private LengthUtil() {
    }

    /** 解析为 mm；null/空/非法 → fallback */
    public static double parseMm(String length, double fallback) {
        if (length == null) {
            return fallback;
        }
        String s = length.trim().toLowerCase();
        try {
            if (s.endsWith("mm")) {
                return Double.parseDouble(s.substring(0, s.length() - 2).trim());
            }
            if (s.endsWith("cm")) {
                return Double.parseDouble(s.substring(0, s.length() - 2).trim()) * 10;
            }
            if (s.endsWith("pt")) {
                return Double.parseDouble(s.substring(0, s.length() - 2).trim()) * 25.4 / 72;
            }
            if (s.endsWith("px")) {
                return Double.parseDouble(s.substring(0, s.length() - 2).trim()) * 25.4 / 96;
            }
            return Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    public static double parseMm(String length) {
        return parseMm(length, 0);
    }

    /** mm → 标签点阵坐标（203dpi，四舍五入） */
    public static int mmToDots(String length, double fallbackMm) {
        return (int) Math.round(parseMm(length, fallbackMm) * DOTS_PER_MM);
    }

    /** mm → PDF point（1pt = 1/72 inch，OpenPDF 单位） */
    public static float mmToPoints(String length, double fallbackMm) {
        return (float) (parseMm(length, fallbackMm) * 72 / 25.4);
    }

    public static float mmToPoints(double mm) {
        return (float) (mm * 72 / 25.4);
    }

    /** 列宽是否百分比 */
    public static boolean isPercent(String width) {
        return width != null && width.trim().endsWith("%");
    }

    public static double parsePercent(String width) {
        try {
            return Double.parseDouble(width.trim().replace("%", ""));
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
