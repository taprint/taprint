/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;

/**
 * 单色位图编码工具（ZPL ^GFA / CPCL EG 共用十六进制行格式）。
 *
 * <p>每像素 1 bit，MSB 在左；每行字节数 = ceil(width/8)，行尾补零位。
 * ESC/POS 光栅位图（GS v 0）共用同一暗色判定（阈值 128），编码逻辑与
 */
public final class MonochromeBitmapUtil {

    private MonochromeBitmapUtil() {
    }

    /** 图像是否暗色（TYPE_BYTE_BINARY 中 0=黑） */
    public static boolean isDark(BufferedImage image, int x, int y) {
        int rgb = image.getRGB(x, y);
        int r = (rgb >> 16) & 0xFF;
        int g = (rgb >> 8) & 0xFF;
        int b = rgb & 0xFF;
        return (r + g + b) / 3 < 128;
    }

    /**
     * 图像 → 十六进制位图串（每字节 2 个 hex 字符，无行分隔）。
     *
     * @return hex 数据
     */
    public static String toHexData(BufferedImage image) {
        int w = image.getWidth();
        int h = image.getHeight();
        int bytesPerRow = (w + 7) / 8;
        StringBuilder sb = new StringBuilder(h * bytesPerRow * 2);
        for (int y = 0; y < h; y++) {
            for (int byteIdx = 0; byteIdx < bytesPerRow; byteIdx++) {
                int b = 0;
                for (int bit = 0; bit < 8; bit++) {
                    int x = byteIdx * 8 + bit;
                    if (x < w && isDark(image, x, y)) {
                        b |= (0x80 >> bit);
                    }
                }
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
        }
        return sb.toString().toUpperCase();
    }

    public static int bytesPerRow(BufferedImage image) {
        return (image.getWidth() + 7) / 8;
    }

    public static int totalBytes(BufferedImage image) {
        return bytesPerRow(image) * image.getHeight();
    }

    /**
      * Monochrome bitmap encoders for the raster-based command channels.
     * <p>头：1D 76 30 00 xL xH yL yH（x=每行字节数，y=行数）；数据逐行逐字节，
     * MSB 在左，行尾补零位。暗色判定阈值 128（与 toHexData 同一口径）。
     *
     * @param image 源图（任意类型；按 {@link #isDark} 阈值 128 二值化）
     * @return GS v 0 光栅位图字节流
     */
    public static byte[] toEscPosRaster(BufferedImage image) {
        int width = image.getWidth();
        int height = image.getHeight();
        int bytesPerLine = (width + 7) / 8;
        ByteArrayOutputStream out = new ByteArrayOutputStream(bytesPerLine * height + 8);
        out.write(0x1D);
        out.write('v');
        out.write('0');
        out.write(0);
        out.write(bytesPerLine & 0xFF);
        out.write((bytesPerLine >> 8) & 0xFF);
        out.write(height & 0xFF);
        out.write((height >> 8) & 0xFF);
        for (int y = 0; y < height; y++) {
            for (int byteIdx = 0; byteIdx < bytesPerLine; byteIdx++) {
                int b = 0;
                for (int bit = 0; bit < 8; bit++) {
                    int x = byteIdx * 8 + bit;
                    if (x < width && isDark(image, x, y)) {
                        b |= (0x80 >> bit);
                    }
                }
                out.write(b);
            }
        }
        return out.toByteArray();
    }

    /**
     * Image to raw binary bitmap bytes (TSPL BITMAP data section).
     * <p>与 {@link #toHexData} 同一 bit 布局（MSB 在左、行尾补零），仅编码形态不同：
     * TSPL BITMAP 数据为原始二进制字节（非 hex）。
     */
    public static byte[] toBinaryData(BufferedImage image) {
        int width = image.getWidth();
        int height = image.getHeight();
        int bytesPerRow = (width + 7) / 8;
        byte[] data = new byte[bytesPerRow * height];
        int idx = 0;
        for (int y = 0; y < height; y++) {
            for (int byteIdx = 0; byteIdx < bytesPerRow; byteIdx++) {
                int b = 0;
                for (int bit = 0; bit < 8; bit++) {
                    int x = byteIdx * 8 + bit;
                    if (x < width && isDark(image, x, y)) {
                        b |= (0x80 >> bit);
                    }
                }
                data[idx++] = (byte) b;
            }
        }
        return data;
    }
}
