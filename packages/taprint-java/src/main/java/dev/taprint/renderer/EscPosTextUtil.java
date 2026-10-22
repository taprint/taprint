/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

/**
 * ESC/POS 等宽字符布局工具。
 *
 * <p>CJK 全角字符占 2 个字符位（GB2312/GBK 半角字体栅格口径），
 * 表格对齐与截断必须按显示宽度而非 String.length。
 */
public final class EscPosTextUtil {

    private EscPosTextUtil() {
    }

    public static int displayWidth(String s) {
        if (s == null) {
            return 0;
        }
        int width = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            width += isWide(c) ? 2 : 1;
        }
        return width;
    }

    public static boolean isWide(char c) {
        Character.UnicodeBlock block = Character.UnicodeBlock.of(c);
        return block == Character.UnicodeBlock.CJK_UNIFIED_IDEOGRAPHS
                || block == Character.UnicodeBlock.CJK_UNIFIED_IDEOGRAPHS_EXTENSION_A
                || block == Character.UnicodeBlock.CJK_COMPATIBILITY_IDEOGRAPHS
                || block == Character.UnicodeBlock.CJK_SYMBOLS_AND_PUNCTUATION
                || block == Character.UnicodeBlock.HALFWIDTH_AND_FULLWIDTH_FORMS
                || block == Character.UnicodeBlock.HIRAGANA
                || block == Character.UnicodeBlock.KATAKANA
                || block == Character.UnicodeBlock.HANGUL_SYLLABLES
                || block == Character.UnicodeBlock.GENERAL_PUNCTUATION && c >= 0x2018;
    }

    /** 按显示宽度截断（不切断全角字符） */
    public static String truncate(String s, int maxWidth) {
        if (s == null || maxWidth <= 0) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        int width = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            int w = isWide(c) ? 2 : 1;
            if (width + w > maxWidth) {
                break;
            }
            sb.append(c);
            width += w;
        }
        return sb.toString();
    }

    /** 按显示宽度补齐到 width 列（align: left/center/right） */
    public static String pad(String s, int width, String align) {
        String t = truncate(s == null ? "" : s, width);
        int gap = width - displayWidth(t);
        if (gap <= 0) {
            return t;
        }
        StringBuilder sb = new StringBuilder();
        if ("right".equalsIgnoreCase(align)) {
            appendSpaces(sb, gap);
            sb.append(t);
        } else if ("center".equalsIgnoreCase(align)) {
            int left = gap / 2;
            appendSpaces(sb, left);
            sb.append(t);
            appendSpaces(sb, gap - left);
        } else {
            sb.append(t);
            appendSpaces(sb, gap);
        }
        return sb.toString();
    }

    public static void appendSpaces(StringBuilder sb, int count) {
        for (int i = 0; i < count; i++) {
            sb.append(' ');
        }
    }

    /** 分隔线（'-' × width） */
    public static String separator(int width) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < width; i++) {
            sb.append('-');
        }
        return sb.toString();
    }
}
