/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.barcode;

import com.google.zxing.common.BitMatrix;

import java.io.ByteArrayOutputStream;

/**
 * 二维码渲染（ZXing）+ ESC/POS 位图兜底（GS v 0）。
 *
 * 服务端生成 QR 位图并以 GS v 0 光栅位图下发（兼容性最好）。
 */
public class QrcodeRenderer {

    private final BarcodeRenderer barcodeRenderer;

    public QrcodeRenderer(BarcodeRenderer barcodeRenderer) {
        this.barcodeRenderer = barcodeRenderer;
    }

    /**
     * QR → ESC/POS 光栅位图字节流（GS v 0，m=0 正常模式）。
     *
     * @param content    QR 内容
     * @param moduleSize 模块等级（1-20，与 DSL qrcode.size 对应）
     */
    public byte[] toEscPosRaster(String content, int moduleSize) {
        BitMatrix matrix = barcodeRenderer.renderQrMatrix(content, Math.max(moduleSize, 2));
        int width = matrix.getWidth();
        int height = matrix.getHeight();
        int bytesPerLine = (width + 7) / 8;
        // 行补齐到 8 的倍数（GS v 0 要求 xL xH 为字节列数）
        int paddedWidth = bytesPerLine * 8;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
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
                    if (x < paddedWidth && x < width && matrix.get(x, y)) {
                        b |= (0x80 >> bit);
                    }
                }
                out.write(b);
            }
        }
        return out.toByteArray();
    }
}
