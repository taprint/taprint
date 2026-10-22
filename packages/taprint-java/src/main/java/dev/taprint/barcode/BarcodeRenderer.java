/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.barcode;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.MultiFormatWriter;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;
import dev.taprint.core.PrintKernelException;
import dev.taprint.core.PrintErrorCode;

import java.awt.image.BufferedImage;
import java.util.HashMap;
import java.util.Map;

/**
 * 一维码渲染（ZXing）。输出位图供 PDF/预览嵌入；
 * ESC/POS/TSPL/ZPL/CPCL 优先用各自原生条码指令（见各渲染器）。
 */
public class BarcodeRenderer {

    /**
     * @param content   条码内容
     * @param symbology 码制
     * @param widthPx   位图宽（像素）
     * @param heightPx  位图高（像素）
     */
    public BufferedImage render(String content, Symbology symbology, int widthPx, int heightPx) {
        try {
            Map<EncodeHintType, Object> hints = new HashMap<>();
            hints.put(EncodeHintType.MARGIN, 0);
            hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
            BarcodeFormat format = symbology.getZxingFormat();
            BitMatrix matrix = new MultiFormatWriter().encode(content, format, widthPx, heightPx, hints);
            return toImage(matrix, 0xFF000000, 0xFFFFFFFF);
        } catch (WriterException e) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_FAILED)
                    .message("条码生成失败: " + e.getMessage())
                    .cause(e)
                    .build();
        }
    }

    /** QR 位图（供 ESC/POS 位图兜底 GS v 0 与 PDF/预览嵌入） */
    public BitMatrix renderQrMatrix(String content, int moduleSize) {
        try {
            Map<EncodeHintType, Object> hints = new HashMap<>();
            hints.put(EncodeHintType.MARGIN, 0);
            hints.put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M);
            hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
            int size = Math.max(moduleSize, 1) * 8;
            return new MultiFormatWriter().encode(content, BarcodeFormat.QR_CODE, size, size, hints);
        } catch (WriterException e) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_FAILED)
                    .message("二维码生成失败: " + e.getMessage())
                    .cause(e)
                    .build();
        }
    }

    public BufferedImage renderQrImage(String content, int sizePx) {
        try {
            Map<EncodeHintType, Object> hints = new HashMap<>();
            hints.put(EncodeHintType.MARGIN, 0);
            hints.put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M);
            hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
            BitMatrix matrix = new MultiFormatWriter().encode(content, BarcodeFormat.QR_CODE, sizePx, sizePx, hints);
            return toImage(matrix, 0xFF000000, 0xFFFFFFFF);
        } catch (WriterException e) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_FAILED)
                    .message("二维码生成失败: " + e.getMessage())
                    .cause(e)
                    .build();
        }
    }

    public static BufferedImage toImage(BitMatrix matrix, int black, int white) {
        int w = matrix.getWidth();
        int h = matrix.getHeight();
        BufferedImage image = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                image.setRGB(x, y, matrix.get(x, y) ? black : white);
            }
        }
        return image;
    }
}
