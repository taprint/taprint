/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;

/**
 * GBK 类命令流编码通道的表外字符策略（ADR-0009 §3）。
 *
 * <p>规则：字符落在目标编码表内 → 原样编码；表外字符 → 以 U+FFFD 的
 * UTF-8 字节序列（EF BF BD）占位，与 TS/C#/Dart 端 golden 契约一致。
 * 禁止静默折 '?'（丢信息）或抛异常中断渲染（表外字符属数据问题，
 * 非内核错误——四语言行为必须一致才能做字节级对拍）。
 *
 * <p>控制字符（CR/LF 等）不归本类管：协议帧结构字符的拒绝由各渲染器的
 * 内容守卫承担（防命令注入），与本策略正交。
 */
public final class GbEncoding {

    /** U+FFFD 的 UTF-8 字节序列（表外字符唯一占位形态）。 */
    public static final byte[] REPLACEMENT = {(byte) 0xEF, (byte) 0xBF, (byte) 0xBD};

    private GbEncoding() {
    }

    /**
     * 按目标编码逐码点编码，表外码点以 U+FFFD 替换。
     *
     * <p>代理对按完整码点判定（emoji 一类增补平面字符整体不可分）；
     * UTF-8 类全覆盖编码无表外码点，退化为直通编码。
     */
    public static byte[] encodeWithReplacement(String text, Charset charset) {
        if (text == null || text.isEmpty()) {
            return new byte[0];
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(text.length() * 2);
        int index = 0;
        while (index < text.length()) {
            int codePoint = text.codePointAt(index);
            int charCount = Character.charCount(codePoint);
            String slice = text.substring(index, index + charCount);
            if (isEncodable(slice, charset)) {
                byte[] encoded = slice.getBytes(charset);
                out.write(encoded, 0, encoded.length);
            } else {
                out.write(REPLACEMENT, 0, REPLACEMENT.length);
            }
            index += charCount;
        }
        return out.toByteArray();
    }

    private static boolean isEncodable(String slice, Charset charset) {
        try {
            return charset.newEncoder().canEncode(slice);
        } catch (RuntimeException e) {
            return false;
        }
    }
}
