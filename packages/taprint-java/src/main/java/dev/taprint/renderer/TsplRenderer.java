/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import dev.taprint.core.PrintKernelException;
import dev.taprint.barcode.Symbology;
import dev.taprint.dsl.LabelPresentation;
import dev.taprint.core.CommandSet;
import dev.taprint.core.PrintErrorCode;

import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.nio.charset.CharsetEncoder;
import java.nio.charset.CodingErrorAction;

/**
  * TSPL2 label renderer emitting raw byte streams.
 * TEXT x,y,"font",rotation,x-mul,y-mul,"content"；QRCODE 7-9 参完整语法。
 */
public class TsplRenderer implements Renderer {

    private static final Charset GBK = Charset.forName("GBK");
    /** 中文字体名（TSC 中文机型内置） */
    private static final String CJK_FONT = "SIMPLIFIED CHINESE";
    /** 内置西文字体 */
    private static final String ASCII_FONT = "3";
    private static final int CJK_FONT_HEIGHT_DOTS = 24;

    private final PrintImageLoader imageLoader;
    private final CjkRasterizer cjkRasterizer;

    public TsplRenderer(PrintImageLoader imageLoader, CjkRasterizer cjkRasterizer) {
        this.imageLoader = imageLoader;
        this.cjkRasterizer = cjkRasterizer;
    }

    @Override
    public CommandSet getCommandSet() {
        return CommandSet.TSPL;
    }

    @Override
    public RenderResult render(EvaluatedTemplate evaluated, RenderContext ctx) {
        checkInterrupted();
        LabelPresentation spec = evaluated.getLabel();
        ByteArrayOutputStream out = new ByteArrayOutputStream(4096);
        try {
            double widthMm = LengthUtil.parseMm(spec.getSize().getWidth(), 60);
            double heightMm = LengthUtil.parseMm(spec.getSize().getHeight(), 40);
            double gapMm = LengthUtil.parseMm(spec.getGap(), 2);
            int density = spec.getDensity() == null ? 8 : Math.max(0, Math.min(15, spec.getDensity()));
            int speed = spec.getSpeed() == null ? 4 : Math.max(1, Math.min(10, spec.getSpeed()));

            append(out, "SIZE " + fmt(widthMm) + " mm," + fmt(heightMm) + " mm");
            append(out, "GAP " + fmt(gapMm) + " mm,0 mm");
            append(out, "DENSITY " + density);
            append(out, "SPEED " + speed);
            append(out, "DIRECTION 1");
            append(out, "CLS");

            for (EvaluatedElement el : evaluated.getBody()) {
                checkInterrupted();
                renderElement(out, el);
            }

            int copies = Math.max(1, ctx.getCopies());
            append(out, "PRINT " + copies);
        } catch (PrintKernelException e) {
            throw e;
        } catch (Exception e) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_FAILED)
                    .message("TSPL 渲染失败: " + e.getMessage())
                    .cause(e)
                    .build();
        }
        return new RenderResult(out.toByteArray(), "application/octet-stream", CommandSet.TSPL);
    }

    /**
     * 元素级中断检查点。
     *
     * <p>口径：CPU 密集段无法硬杀，元素边界足够——超时后 Future.cancel(true)
     * 中断渲染线程，线程在下一个元素边界发现中断立即抛 RENDER_TIMEOUT，
     * 尽快归还池线程。
     */
    private static void checkInterrupted() {
        if (Thread.interrupted()) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_TIMEOUT)
                    .message("渲染线程已中断（超时取消）")
                    .build();
        }
    }

    private void renderElement(ByteArrayOutputStream out, EvaluatedElement el) throws Exception {
        String type = el.getType();
        if (type == null) {
            return;
        }
        int x = LengthUtil.mmToDots(el.getX(), 0);
        int y = LengthUtil.mmToDots(el.getY(), 0);
        switch (type) {
            case "text":
                renderText(out, el, x, y);
                break;
            case "barcode":
                renderBarcode(out, el, x, y);
                break;
            case "qrcode":
                renderQrcode(out, el, x, y);
                break;
            case "image":
                renderImage(out, el, x, y);
                break;
            case "line":
                append(out, "LINE " + x + "," + y + ","
                        + (x + LengthUtil.mmToDots(el.getWidth(), 50)) + ","
                        + (y + LengthUtil.mmToDots(el.getHeight(), 0)) + ",2");
                break;
            case "rect":
                append(out, "BOX " + x + "," + y + ","
                        + (x + LengthUtil.mmToDots(el.getWidth(), 30)) + ","
                        + (y + LengthUtil.mmToDots(el.getHeight(), 20)) + ",2");
                break;
            default:
                throw PrintKernelException.builder()
                        .errorCode(PrintErrorCode.UNSUPPORTED_ELEMENT)
                        .message("label 呈现不支持元素类型: " + type)
                        .build();
        }
    }

    /**
     * Label image: load, decode, binarizing rescale, then the TSPL BITMAP command.
     * <p>BITMAP x,y,widthBytes,height,mode,data——width 为**字节数**（ceil(px/8)），
     * 高度按行；数据为**二进制字节**（非 hex，TSPL 与 ZPL/CPCL 的编码形态差异点）。
     * 目标尺寸按 DSL width/height（mm）换算 203dpi 点阵，缺省按源图等比。
     */
    private void renderImage(ByteArrayOutputStream out, EvaluatedElement el, int x, int y) throws Exception {
        byte[] bytes = imageLoader.load(el.getText());
        if (bytes == null) {
            return;
        }
        java.awt.image.BufferedImage src = cjkRasterizer.decode(bytes);
        if (src == null) {
            return;
        }
        int hDots = el.getHeight() != null && !el.getHeight().trim().isEmpty()
                ? LengthUtil.mmToDots(el.getHeight(), 0) : src.getHeight();
        int wDots = el.getWidth() == null || el.getWidth().trim().isEmpty()
                ? 0 : LengthUtil.mmToDots(el.getWidth(), 0);
        java.awt.image.BufferedImage img = cjkRasterizer.rasterizeImage(src, hDots, wDots);
        int bytesPerRow = MonochromeBitmapUtil.bytesPerRow(img);
        int height = img.getHeight();
        byte[] prefix = ("BITMAP " + x + "," + y + "," + bytesPerRow + "," + height + ",0,").getBytes(GBK);
        out.write(prefix, 0, prefix.length);
        out.write(MonochromeBitmapUtil.toBinaryData(img), 0, MonochromeBitmapUtil.totalBytes(img));
        byte[] eol = "\r\n".getBytes(GBK);
        out.write(eol, 0, eol.length);
    }

    private void renderText(ByteArrayOutputStream out, EvaluatedElement el, int x, int y) {
        String content = el.getText() == null ? "" : el.getText();
        if (content.isEmpty()) {
            return;
        }
        String font = el.getFont();
        int mul = el.getSize() == null ? 1 : Math.max(1, Math.min(10, el.getSize()));
        int lineDots = CJK_FONT_HEIGHT_DOTS * mul;
        int lineNo = 0;
        for (String line : content.split("\n", -1)) {
            requirePrintSafe(line);
            String safeFont = font != null && !font.trim().isEmpty()
                    ? requireFontName(font)
                    : (containsCjk(line) ? CJK_FONT : ASCII_FONT);
            // TEXT x,y,"font",rotation,x-multiplication,y-multiplication,"content"
            append(out, "TEXT " + x + "," + (y + lineNo * lineDots) + ",\"" + safeFont + "\",0," + mul + "," + mul + ",\"" + escape(line) + "\"");
            lineNo++;
        }
    }

    private void renderBarcode(ByteArrayOutputStream out, EvaluatedElement el, int x, int y) {
        String content = el.getText() == null ? "" : el.getText();
        if (content.isEmpty()) {
            return;
        }
        requirePrintSafe(content);
        Symbology symbology = Symbology.of(el.getSymbology());
        int height = LengthUtil.mmToDots(el.getHeight(), 10);
        // BARCODE x,y,"type",height,human_readable,rotation,narrow,wide,"content"
        append(out, "BARCODE " + x + "," + y + ",\"" + tsplBarcodeType(symbology) + "\"," + height + ",1,0,2,2,\"" + escape(content) + "\"");
    }

    private String tsplBarcodeType(Symbology symbology) {
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
                return "ITF13";
            case CODE128:
            default:
                return "128";
        }
    }

    private void renderQrcode(ByteArrayOutputStream out, EvaluatedElement el, int x, int y) {
        String content = el.getText() == null ? "" : el.getText();
        if (content.isEmpty()) {
            return;
        }
        requirePrintSafe(content);
        int cell = el.getSize() == null ? 6 : Math.max(1, Math.min(10, el.getSize()));
        append(out, "QRCODE " + x + "," + y + ",M," + cell + ",A,0,M2,\"" + escape(content) + "\"");
    }

    static boolean containsCjk(String s) {
        for (int i = 0; i < s.length(); i++) {
            if (EscPosTextUtil.isWide(s.charAt(i))) {
                return true;
            }
        }
        return false;
    }

    /** TSPL 内容转义：双引号与反斜杠 */
    static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private void append(ByteArrayOutputStream out, String line) {
        requireGbkEncodable(line);
        byte[] bytes = (line + "\r\n").getBytes(GBK);
        out.write(bytes, 0, bytes.length);
    }

    private static String requireFontName(String font) {
        String value = font.trim();
        if (value.isEmpty() || value.length() > 64) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_FAILED)
                    .message("TSPL font name is missing or too long")
                    .build();
        }
        for (int index = 0; index < value.length(); index++) {
            char item = value.charAt(index);
            boolean allowed = Character.isLetterOrDigit(item)
                    || item == ' ' || item == '-' || item == '_'
                    || item == '.' || item == '(' || item == ')';
            if (!allowed) {
                throw PrintKernelException.builder()
                        .errorCode(PrintErrorCode.RENDER_FAILED)
                        .message("TSPL font name contains unsupported characters")
                        .build();
            }
        }
        return value;
    }

    private static void requirePrintSafe(String content) {
        for (int index = 0; index < content.length(); index++) {
            if (Character.isISOControl(content.charAt(index))) {
                throw PrintKernelException.builder()
                        .errorCode(PrintErrorCode.RENDER_FAILED)
                        .message("TSPL content contains control characters")
                        .build();
            }
        }
        requireGbkEncodable(content);
    }

    private static void requireGbkEncodable(String content) {
        CharsetEncoder encoder = GBK.newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        try {
            encoder.encode(java.nio.CharBuffer.wrap(content));
        } catch (Exception e) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_FAILED)
                    .message("TSPL content cannot be encoded as GBK")
                    .cause(e)
                    .build();
        }
    }

    private String fmt(double mm) {
        if (mm == Math.rint(mm)) {
            return String.valueOf((long) mm);
        }
        return String.valueOf(mm);
    }
}
