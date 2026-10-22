/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import dev.taprint.core.PrintKernelException;
import dev.taprint.barcode.Symbology;
import dev.taprint.dsl.LabelPresentation;
import dev.taprint.core.CommandSet;
import dev.taprint.core.PrintErrorCode;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/**
  * CPCL renderer for portable label printers.
 * CJK 文本走 EG 位图通道。
 */
public class CpclRenderer implements Renderer {

    private static final int CJK_FONT_HEIGHT = 32;

    private final CjkRasterizer cjkRasterizer;
    private final PrintImageLoader imageLoader;

    public CpclRenderer(CjkRasterizer cjkRasterizer, PrintImageLoader imageLoader) {
        this.cjkRasterizer = cjkRasterizer;
        this.imageLoader = imageLoader;
    }

    @Override
    public CommandSet getCommandSet() {
        return CommandSet.CPCL;
    }

    @Override
    public RenderResult render(EvaluatedTemplate evaluated, RenderContext ctx) {
        checkInterrupted();
        LabelPresentation spec = evaluated.getLabel();
        StringBuilder cpcl = new StringBuilder(2048);
        try {
            int heightDots = LengthUtil.mmToDots(spec.getSize().getHeight(), 40);
            int qty = Math.max(1, ctx.getCopies());
            // 格式头：! offset horz vert height qty（200 DPI）
            cpcl.append("! 0 200 200 ").append(heightDots).append(' ').append(qty).append('\r').append('\n');

            for (EvaluatedElement el : evaluated.getBody()) {
                checkInterrupted();
                renderElement(cpcl, el);
            }

            cpcl.append("FORM").append('\r').append('\n');
            cpcl.append("PRINT").append('\r').append('\n');
        } catch (PrintKernelException e) {
            throw timeoutIfInterrupted(e);
        } catch (Exception e) {
            throw timeoutIfInterrupted(PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_FAILED)
                    .message("CPCL 渲染失败: " + e.getMessage())
                    .cause(e)
                    .build());
        }
        checkInterrupted();
        return new RenderResult(cpcl.toString().getBytes(StandardCharsets.US_ASCII),
                "application/octet-stream", CommandSet.CPCL);
    }

    private static RuntimeException timeoutIfInterrupted(RuntimeException original) {
        if (!Thread.currentThread().isInterrupted()) {
            return original;
        }
        Thread.interrupted();
        return PrintKernelException.builder()
                .errorCode(PrintErrorCode.RENDER_TIMEOUT)
                .message("渲染线程已中断（超时取消）")
                .cause(original)
                .build();
    }

    private static void checkInterrupted() {
        if (Thread.interrupted()) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_TIMEOUT)
                    .message("渲染线程已中断（超时取消）")
                    .build();
        }
    }

    private void renderElement(StringBuilder cpcl, EvaluatedElement el) {
        String type = el.getType();
        if (type == null) {
            return;
        }
        int x = LengthUtil.mmToDots(el.getX(), 0);
        int y = LengthUtil.mmToDots(el.getY(), 0);
        switch (type) {
            case "text":
                renderText(cpcl, el, x, y);
                break;
            case "barcode":
                renderBarcode(cpcl, el, x, y);
                break;
            case "qrcode":
                renderQrcode(cpcl, el, x, y);
                break;
            case "line":
                cpcl.append("LINE ").append(x).append(' ').append(y).append(' ')
                        .append(x + LengthUtil.mmToDots(el.getWidth(), 50)).append(' ').append(y)
                        .append(' ').append(2).append('\r').append('\n');
                break;
            case "rect":
                cpcl.append("BOX ").append(x).append(' ').append(y).append(' ')
                        .append(x + LengthUtil.mmToDots(el.getWidth(), 30)).append(' ')
                        .append(y + LengthUtil.mmToDots(el.getHeight(), 20))
                        .append(' ').append(2).append('\r').append('\n');
                break;
            case "image":
                renderImage(cpcl, el, x, y);
                break;
            default:
                throw PrintKernelException.builder()
                        .errorCode(PrintErrorCode.UNSUPPORTED_ELEMENT)
                        .message("label 呈现不支持元素类型: " + type)
                        .build();
        }
    }

    private void renderText(StringBuilder cpcl, EvaluatedElement el, int x, int y) {
        String content = el.getText() == null ? "" : el.getText();
        if (content.isEmpty()) {
            return;
        }
        int mul = el.getSize() == null ? 1 : Math.max(1, Math.min(8, el.getSize()));
        int lineNo = 0;
        for (String line : content.split("\n", -1)) {
            if (TsplRenderer.containsCjk(line)) {
                renderCjkGraphic(cpcl, line, x, y + lineNo * CJK_FONT_HEIGHT * mul, mul);
            } else {
                // TEXT font size x y content（内容不加引号，行尾结束）
                cpcl.append("TEXT 4 ").append(mul - 1).append(' ').append(x).append(' ')
                        .append(y + lineNo * 24 * mul).append(' ').append(sanitize(line))
                        .append('\r').append('\n');
            }
            lineNo++;
        }
    }

    /** CJK → EG 位图（CPCL 图形命令，hex 行格式与 ZPL ^GFA 一致） */
    private void renderCjkGraphic(StringBuilder cpcl, String line, int x, int y, int mul) {
        BufferedImage image = cjkRasterizer.rasterize(line, CJK_FONT_HEIGHT * mul);
        renderEg(cpcl, image, x, y);
    }

    /**
     * Label image: load, decode, binarizing rescale, then the EG bitmap channel.
     * <p>EG widthBytes height x y <hex>，与 CJK 文本同一通道；目标尺寸按 DSL
     * width/height（mm）换算 200dpi 点阵（CPCL 格式头固定 200 DPI），缺省按源图等比。
     */
    private void renderImage(StringBuilder cpcl, EvaluatedElement el, int x, int y) {
        byte[] bytes = imageLoader.load(el.getText());
        if (bytes == null) {
            return;
        }
        BufferedImage src = cjkRasterizer.decode(bytes);
        if (src == null) {
            return;
        }
        int hDots = el.getHeight() != null && !el.getHeight().trim().isEmpty()
                ? LengthUtil.mmToDots(el.getHeight(), 0) : src.getHeight();
        int wDots = el.getWidth() == null || el.getWidth().trim().isEmpty()
                ? 0 : LengthUtil.mmToDots(el.getWidth(), 0);
        BufferedImage image = cjkRasterizer.rasterizeImage(src, hDots, wDots);
        renderEg(cpcl, image, x, y);
    }

    /** 图像 → EG widthBytes height x y <hex> */
    private void renderEg(StringBuilder cpcl, BufferedImage image, int x, int y) {
        int perRow = MonochromeBitmapUtil.bytesPerRow(image);
        int height = image.getHeight();
        String hex = MonochromeBitmapUtil.toHexData(image);
        cpcl.append("EG ").append(perRow).append(' ').append(height).append(' ')
                .append(x).append(' ').append(y).append(' ').append(hex)
                .append('\r').append('\n');
    }

    private void renderBarcode(StringBuilder cpcl, EvaluatedElement el, int x, int y) {
        String content = el.getText() == null ? "" : el.getText();
        if (content.isEmpty()) {
            return;
        }
        Symbology symbology = Symbology.of(el.getSymbology());
        int height = LengthUtil.mmToDots(el.getHeight(), 10);
        // BARCODE type width ratio height x y content
        cpcl.append("BARCODE ").append(cpclBarcodeType(symbology)).append(" 2 1 ")
                .append(height).append(' ').append(x).append(' ').append(y).append(' ')
                .append(sanitize(content)).append('\r').append('\n');
    }

    private String cpclBarcodeType(Symbology symbology) {
        switch (symbology) {
            case EAN13:
                return "EAN13";
            case EAN8:
                return "EAN8";
            case UPC:
                return "UPCA";
            case CODE39:
                return "39";
            case ITF:
                return "I2OF5";
            case CODE128:
            default:
                return "128";
        }
    }

    /**
     * BARCODE QR x y M model U unit / 数据行 M0A,data / ENDQR。
     * M=QR 型号（官方默认 2，非纠错等级）；U=单元大小(1-32)。
     */
    private void renderQrcode(StringBuilder cpcl, EvaluatedElement el, int x, int y) {
        String content = el.getText() == null ? "" : el.getText();
        if (content.isEmpty()) {
            return;
        }
        int unit = el.getSize() == null ? 7 : Math.max(1, Math.min(32, el.getSize()));
        cpcl.append("BARCODE QR ").append(x).append(' ').append(y)
                .append(" M 2 U ").append(unit).append('\r').append('\n');
        cpcl.append("M0A,").append(sanitize(content)).append('\r').append('\n');
        cpcl.append("ENDQR").append('\r').append('\n');
    }

    /** CPCL 文本内容不加引号，行尾结束——移除换行防截断 */
    static String sanitize(String s) {
        return s.replace("\r", " ").replace("\n", " ");
    }
}
