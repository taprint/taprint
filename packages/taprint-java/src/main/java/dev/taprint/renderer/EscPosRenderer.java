/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import dev.taprint.core.PrintKernelException;
import dev.taprint.barcode.QrcodeRenderer;
import dev.taprint.barcode.Symbology;
import dev.taprint.dsl.DslElement;
import dev.taprint.dsl.ReceiptPresentation;
import dev.taprint.dsl.TableColumn;
import dev.taprint.core.CommandSet;
import dev.taprint.core.PrintErrorCode;

import java.io.ByteArrayOutputStream;
import java.io.UnsupportedEncodingException;
import java.nio.charset.Charset;
import java.nio.charset.UnsupportedCharsetException;
import java.util.List;

/**
  * ESC/POS receipt renderer emitting raw byte streams.
 * <p>列数由设备档案 maxWidthCols 驱动（不硬编码）；无设备档案时用保守默认
 * （32 列/GBK/不假定原生 QR）。QR 优先原生 GS ( k，否则 ZXing 位图 GS v 0 兜底。
 */
public class EscPosRenderer implements Renderer {

    private static final byte[] INIT = {0x1B, 0x40};
    private static final byte[] LF = {0x0A};
    private static final byte[] KANJI_MODE_ON = {0x1C, 0x26};

    private final QrcodeRenderer qrcodeRenderer;
    private final PrintImageLoader imageLoader;
    private final CjkRasterizer cjkRasterizer;

    public EscPosRenderer(QrcodeRenderer qrcodeRenderer, PrintImageLoader imageLoader, CjkRasterizer cjkRasterizer) {
        this.qrcodeRenderer = qrcodeRenderer;
        this.imageLoader = imageLoader;
        this.cjkRasterizer = cjkRasterizer;
    }

    @Override
    public CommandSet getCommandSet() {
        return CommandSet.ESC_POS;
    }

    @Override
    public RenderResult render(EvaluatedTemplate evaluated, RenderContext ctx) {
        checkInterrupted();
        DeviceProfile dp = ctx.getDeviceProfile();
        EscPosCapability cap = dp != null && dp.getEscPos() != null ? dp.getEscPos() : EscPosCapability.defaults();
        ReceiptPresentation spec = evaluated.getReceipt();
        int widthCols = cap.getMaxWidthCols() > 0 ? cap.getMaxWidthCols() : 32;
        Charset charset = resolveCharset(cap.getEncoding());

        ByteArrayOutputStream out = new ByteArrayOutputStream(8192);
        try {
            write(out, INIT);
            writeInitCommands(out, spec);
            if (isGbkLike(charset)) {
                write(out, KANJI_MODE_ON);
            }
            for (EvaluatedElement el : evaluated.getBody()) {
                checkInterrupted();
                renderElement(out, el, cap, widthCols, charset);
            }
            writeTailCommands(out, spec);

            // 一撕就残留内容）。出票末尾无条件追加 8 行走纸（默认行高 ≈30mm），
            // 保证撕纸位落在内容下方空白区；模板显式 cut 的前置走纸在 writeCut 内另计。
            for (int i = 0; i < 8; i++) {
                write(out, LF);
            }
        } catch (PrintKernelException e) {
            throw e;
        } catch (Exception e) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_FAILED)
                    .message("ESC/POS 渲染失败: " + e.getMessage())
                    .cause(e)
                    .build();
        }
        return new RenderResult(out.toByteArray(), "application/octet-stream", CommandSet.ESC_POS);
    }

    /**
     * 元素级中断检查点。
     *
     * <p>口径：CPU 密集段无法硬杀（如 CJK 栅格化中途），元素边界已足够——
     * 超时后 Future.cancel(true) 中断渲染线程，线程在下一个元素边界发现中断
     * 立即抛 RENDER_TIMEOUT，尽快归还池线程。Thread.interrupted() 会清除中断位，
     * 此处抛出后线程不再继续执行，无需恢复。
     */
    private static void checkInterrupted() {
        if (Thread.interrupted()) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_TIMEOUT)
                    .message("渲染线程已中断（超时取消）")
                    .build();
        }
    }

    private void renderElement(ByteArrayOutputStream out, EvaluatedElement el,
                               EscPosCapability cap, int widthCols, Charset charset) throws Exception {
        String type = el.getType();
        if (type == null) {
            return;
        }
        switch (type) {
            case "text":
                renderText(out, el, cap, charset);
                break;
            case "kvtable":
                renderKvTable(out, el, widthCols, charset);
                break;
            case "table":
                renderTable(out, el, widthCols, charset);
                break;
            case "barcode":
                renderBarcode(out, el);
                break;
            case "qrcode":
                renderQrcode(out, el, cap);
                break;
            case "image":
                renderImage(out, el, cap, widthCols);
                break;
            case "line":
                writeAlign(out, "left");
                writeText(out, EscPosTextUtil.separator(widthCols), charset);
                write(out, LF);
                break;
            case "spacer":
                write(out, LF);
                break;
            case "cut":
                writeCut(out, el);
                break;
            case "cashDrawer":
                writeCashDrawer(out, el);
                break;
            default:
                // image/pageBreak/rect 在小票呈现无意义，按空行容错
                write(out, LF);
        }
    }

    // ---- image ----

    /**
     * Receipt image: load, binarize, emit as a GS v 0 raster bitmap.
     * <p>宽度上限 = 列数 × 每列点宽（Font A 12 dot/列，80mm 48 列 ≈ 576 dot），
     */
    private void renderImage(ByteArrayOutputStream out, EvaluatedElement el,
                             EscPosCapability cap, int widthCols) throws Exception {
        byte[] bytes = imageLoader.load(el.getText());
        if (bytes == null) {
            return;
        }
        java.awt.image.BufferedImage src = cjkRasterizer.decode(bytes);
        if (src == null) {
            return;
        }
        int capDots = Math.max(32, widthCols * 12);
        java.awt.image.BufferedImage scaled = cjkRasterizer.rasterizeImage(src, src.getHeight(), capDots);
        writeAlign(out, el.getAlign() == null ? "center" : el.getAlign());
        write(out, MonochromeBitmapUtil.toEscPosRaster(scaled));
        write(out, LF);
    }

    // ---- text ----

    private void renderText(ByteArrayOutputStream out, EvaluatedElement el,
                            EscPosCapability cap, Charset charset) throws Exception {
        String text = el.getText() == null ? "" : el.getText();
        writeAlign(out, el.getAlign());
        byte fontSizeCmd = mapFontSize(el, cap.getMaxFontScale());
        write(out, new byte[]{0x1D, 0x21, fontSizeCmd});
        boolean bold = el.getStyle() != null && Boolean.TRUE.equals(el.getStyle().getBold());
        write(out, new byte[]{0x1B, 0x45, (byte) (bold ? 1 : 0)});
        // Epson ESC/POS 的 GS ! 只改字符尺寸，**行距（LF 走纸）与字高无关**（默认行距固定），
        // 倍高行换行只走 1 行 ⇒ 下一行叠上来。修法：按高度倍数补 LF
        // （倍高 2 倍补 1 个、3 倍补 2 个……normal 恒 1 个不变）。
        int heightScale = mapHeightScale(el, cap.getMaxFontScale());
        for (String line : text.split("\n", -1)) {
            writeText(out, line, charset);
            for (int i = 0; i < heightScale; i++) {
                write(out, LF);
            }
        }
        write(out, new byte[]{0x1D, 0x21, 0x00});
        write(out, new byte[]{0x1B, 0x45, 0x00});
    }

    /**
     * 字号 → 行高倍数（LF 补足用）：tall/double=2、triple=3、quadruple=4、其余=1。
     * 与 {@link #mapFontSize} 的 maxFontScale 截断同口径（禁两处漂移）。
     */
    private int mapHeightScale(EvaluatedElement el, int maxFontScale) {
        Object fs = el.getStyle() == null ? null : el.getStyle().getFontSize();
        String name = fs == null ? "normal" : String.valueOf(fs);
        int scale;
        switch (name) {
            case "tall":
            case "double":
                scale = 2;
                break;
            case "triple":
                scale = 3;
                break;
            case "quadruple":
                scale = 4;
                break;
            default:
                return 1;   // normal / wide：行高不变
        }
        if (maxFontScale > 0 && scale > maxFontScale) {
            scale = maxFontScale;
        }
        return scale;
    }

    private byte mapFontSize(EvaluatedElement el, int maxFontScale) {
        Object fs = el.getStyle() == null ? null : el.getStyle().getFontSize();
        String name = fs == null ? "normal" : String.valueOf(fs);
        int scale;
        switch (name) {
            case "tall":
                return 0x01;
            case "wide":
                return 0x10;
            case "double":
                scale = 2;
                break;
            case "triple":
                scale = 3;
                break;
            case "quadruple":
                scale = 4;
                break;
            default:
                return 0x00;
        }
        if (maxFontScale > 0 && scale > maxFontScale) {
            scale = maxFontScale;
        }
        return (byte) (((scale - 1) << 4) | (scale - 1));
    }

    // ---- kvtable ----

    private void renderKvTable(ByteArrayOutputStream out, EvaluatedElement el,
                               int widthCols, Charset charset) throws Exception {
        writeAlign(out, "left");
        if (el.getKvRows() == null) {
            return;
        }
        for (List<String[]> row : el.getKvRows()) {
            if (row == null || row.isEmpty()) {
                write(out, LF);
                continue;
            }
            StringBuilder line = new StringBuilder();
            int pairWidth = widthCols / row.size();
            for (String[] pair : row) {
                String k = pair.length > 0 && pair[0] != null ? pair[0] : "";
                String v = pair.length > 1 && pair[1] != null ? pair[1] : "";
                if (row.size() == 1) {
                    // 单对行：键左值右
                    int kw = EscPosTextUtil.displayWidth(k);
                    int vw = EscPosTextUtil.displayWidth(v);
                    if (kw + vw + 1 <= widthCols) {
                        line.append(EscPosTextUtil.pad(k, widthCols - vw, "left")).append(v);
                    } else {
                        line.append(k).append(':').append(v);
                    }
                } else {
                    line.append(EscPosTextUtil.pad(k + ":" + v, pairWidth, "left"));
                }
            }
            writeText(out, EscPosTextUtil.truncate(line.toString(), widthCols), charset);
            write(out, LF);
        }
    }

    // ---- table ----

    private void renderTable(ByteArrayOutputStream out, EvaluatedElement el,
                             int widthCols, Charset charset) throws Exception {
        List<TableColumn> cols = el.getColumns();
        if (cols == null || cols.isEmpty()) {
            return;
        }
        int[] widths = computeColumnWidths(cols, widthCols);
        writeAlign(out, "left");
        // 表头
        StringBuilder header = new StringBuilder();
        for (int i = 0; i < cols.size(); i++) {
            String h = el.getHeaders() != null && i < el.getHeaders().size() ? el.getHeaders().get(i) : "";
            header.append(EscPosTextUtil.pad(h, widths[i], cols.get(i).getAlign()));
        }
        writeText(out, header.toString(), charset);
        write(out, LF);
        writeText(out, EscPosTextUtil.separator(widthCols), charset);
        write(out, LF);
        // 明细行（rows 已在求值层按列 format 格式化）
        if (el.getRows() != null) {
            for (List<String> row : el.getRows()) {
                int maxLines = 1;
                String[][] cells = new String[cols.size()][];
                for (int i = 0; i < cols.size(); i++) {
                    String cell = i < row.size() && row.get(i) != null ? row.get(i) : "";
                    cells[i] = wrap(cell, widths[i]);
                    maxLines = Math.max(maxLines, cells[i].length);
                }
                for (int line = 0; line < maxLines; line++) {
                    StringBuilder sb = new StringBuilder();
                    for (int i = 0; i < cols.size(); i++) {
                        String part = line < cells[i].length ? cells[i][line] : "";
                        sb.append(EscPosTextUtil.pad(part, widths[i], cols.get(i).getAlign()));
                    }
                    writeText(out, sb.toString(), charset);
                    write(out, LF);
                }
            }
        }
        // 合计区
        if (el.getSummary() != null) {
            writeText(out, EscPosTextUtil.separator(widthCols), charset);
            write(out, LF);
            for (EvaluatedElement.EvaluatedSummary s : el.getSummary()) {
                String label = s.getLabel() == null ? "" : s.getLabel();
                String value = s.getValue() == null ? "" : s.getValue();
                int vw = EscPosTextUtil.displayWidth(value);
                String line = EscPosTextUtil.pad(label, widthCols - vw, "left") + value;
                writeText(out, EscPosTextUtil.truncate(line, widthCols), charset);
                write(out, LF);
            }
        }
    }

    /** 列宽分配：百分比列按比例，其余均分剩余 */
    static int[] computeColumnWidths(List<TableColumn> cols, int widthCols) {
        int[] widths = new int[cols.size()];
        double percentSum = 0;
        int unspecified = 0;
        for (TableColumn c : cols) {
            if (c.getWidth() != null && LengthUtil.isPercent(c.getWidth())) {
                percentSum += LengthUtil.parsePercent(c.getWidth());
            } else {
                unspecified++;
            }
        }
        int used = 0;
        for (int i = 0; i < cols.size(); i++) {
            TableColumn c = cols.get(i);
            if (c.getWidth() != null && LengthUtil.isPercent(c.getWidth())) {
                widths[i] = Math.max(1, (int) Math.round(widthCols * LengthUtil.parsePercent(c.getWidth()) / 100d));
                used += widths[i];
            }
        }
        if (unspecified > 0) {
            int remain = Math.max(unspecified, widthCols - used);
            int each = remain / unspecified;
            int extra = remain - each * unspecified;
            for (int i = 0; i < cols.size(); i++) {
                TableColumn c = cols.get(i);
                if (c.getWidth() == null || !LengthUtil.isPercent(c.getWidth())) {
                    widths[i] = each + (extra > 0 ? 1 : 0);
                    if (extra > 0) {
                        extra--;
                    }
                }
            }
        }
        return widths;
    }

    /** 按显示宽度折行 */
    static String[] wrap(String text, int width) {
        if (text == null || text.isEmpty()) {
            return new String[]{""};
        }
        java.util.List<String> lines = new java.util.ArrayList<>();
        String rest = text;
        while (EscPosTextUtil.displayWidth(rest) > width) {
            String cut = EscPosTextUtil.truncate(rest, width);
            if (cut.isEmpty()) {
                cut = rest.substring(0, 1);
            }
            lines.add(cut);
            rest = rest.substring(cut.length());
        }
        lines.add(rest);
        return lines.toArray(new String[0]);
    }

    // ---- barcode ----

    private void renderBarcode(ByteArrayOutputStream out, EvaluatedElement el) throws Exception {
        String content = el.getText() == null ? "" : el.getText();
        if (content.isEmpty()) {
            return;
        }
        Symbology symbology = Symbology.of(el.getSymbology());
        writeAlign(out, el.getAlign());
        // HRI 位置：条码下方
        write(out, new byte[]{0x1D, 0x48, 0x02});
        int heightDots = LengthUtil.mmToDots(el.getHeight(), 10);
        write(out, new byte[]{0x1D, 0x68, (byte) Math.min(255, Math.max(1, heightDots))});
        write(out, new byte[]{0x1D, 0x77, 0x02});
        byte[] data = content.getBytes("US-ASCII");
        // GS k m(function B) n data
        write(out, new byte[]{0x1D, 0x6B, (byte) symbology.getEscPosFunctionCode(), (byte) data.length});
        write(out, data);
        write(out, LF);
    }

    // ---- qrcode ----

    private void renderQrcode(ByteArrayOutputStream out, EvaluatedElement el, EscPosCapability cap) throws Exception {
        String content = el.getText() == null ? "" : el.getText();
        if (content.isEmpty()) {
            return;
        }
        int size = el.getSize() == null ? 6 : Math.max(1, Math.min(16, el.getSize()));
        writeAlign(out, el.getAlign() == null ? "center" : el.getAlign());
        if (cap.isNativeQrCode()) {
            writeQrCodeNative(out, content, size);
        } else {
            write(out, qrcodeRenderer.toEscPosRaster(content, size));
        }
        write(out, LF);
    }

    static void writeQrCodeNative(ByteArrayOutputStream out, String content, int size) throws UnsupportedEncodingException {
        // 1. 模型 2：1D 28 6B 04 00 31 41 02 00
        write(out, new byte[]{0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x02, 0x00});
        // 2. 模块大小：1D 28 6B 03 00 31 43 n
        write(out, new byte[]{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, (byte) size});
        // 3. 纠错 M(15%)：1D 28 6B 03 00 31 45 31
        write(out, new byte[]{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31});
        // 4. 存数据：1D 28 6B pL pH 31 50 30 data
        byte[] data = content.getBytes("UTF-8");
        int len = data.length + 3;
        write(out, new byte[]{0x1D, 0x28, 0x6B, (byte) (len & 0xFF), (byte) ((len >> 8) & 0xFF), 0x31, 0x50, 0x30});
        write(out, data);
        // 5. 打印：1D 28 6B 03 00 31 51 30
        write(out, new byte[]{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30});
    }

    // ---- cut / cashDrawer ----

    private void writeCut(ByteArrayOutputStream out, EvaluatedElement el) {
        // 切纸前留白 8 行（≈30mm 撕口余量；与主流程尾部走纸同口径——
        write(out, new byte[]{0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A});
        boolean partial = el.getPartial() == null || el.getPartial();
        write(out, new byte[]{0x1D, 0x56, (byte) (partial ? 0x01 : 0x00)});
    }

    private void writeCashDrawer(ByteArrayOutputStream out, EvaluatedElement el) {
        int pulse = el.getPulse() == null ? 1 : el.getPulse();
        int m = pulse == 2 ? 0x01 : 0x00;
        // ESC p m t1 t2（t=25 → 25×2ms=50ms 脉冲宽度）
        write(out, new byte[]{0x1B, 0x70, (byte) m, 0x19, 0x19});
    }

    // ---- init/tail 命令（DSL 白名单映射，未知命令忽略） ----

    private void writeInitCommands(ByteArrayOutputStream out, ReceiptPresentation spec) {
        if (spec == null || spec.getInitCommands() == null) {
            return;
        }
        for (String cmd : spec.getInitCommands()) {
            byte[] bytes = mapKnownCommand(cmd);
            if (bytes != null && bytes != INIT) {
                write(out, bytes);
            }
        }
    }

    private void writeTailCommands(ByteArrayOutputStream out, ReceiptPresentation spec) {
        if (spec == null || spec.getTailCommands() == null) {
            return;
        }
        for (String cmd : spec.getTailCommands()) {
            byte[] bytes = mapKnownCommand(cmd);
            if (bytes != null) {
                write(out, bytes);
            }
        }
    }

    private byte[] mapKnownCommand(String cmd) {
        if (cmd == null) {
            return null;
        }
        String norm = cmd.trim().toUpperCase().replaceAll("\\s+", " ");
        switch (norm) {
            case "ESC @":
                return INIT;
            case "GS V 0":
            case "GS V 48":
                return new byte[]{0x1D, 0x56, 0x00};
            case "GS V 1":
            case "GS V 49":
                return new byte[]{0x1D, 0x56, 0x01};
            default:
                return null;
        }
    }

    // ---- 基础写 ----

    private void writeAlign(ByteArrayOutputStream out, String align) {
        byte n = 0x00;
        if ("center".equalsIgnoreCase(align)) {
            n = 0x01;
        } else if ("right".equalsIgnoreCase(align)) {
            n = 0x02;
        }
        write(out, new byte[]{0x1B, 0x61, n});
    }

    private void writeText(ByteArrayOutputStream out, String text, Charset charset) {
        if (text == null || text.isEmpty()) {
            return;
        }
        write(out, text.getBytes(charset));
    }

    private static void write(ByteArrayOutputStream out, byte[] bytes) {
        out.write(bytes, 0, bytes.length);
    }

    private Charset resolveCharset(String encoding) {
        String name = encoding == null ? "GBK" : encoding;
        switch (name.toLowerCase()) {
            case "gbk":
            case "gb2312":
            case "gb18030":
                try {
                    return Charset.forName("GBK");
                } catch (UnsupportedCharsetException e) {
                    return Charset.forName("GB18030");
                }
            case "big5":
                return Charset.forName("Big5");
            case "utf-8":
            case "utf8":
                return Charset.forName("UTF-8");
            default:
                return Charset.forName("GBK");
        }
    }

    private boolean isGbkLike(Charset charset) {
        String name = charset.name().toUpperCase();
        return name.contains("GBK") || name.contains("GB2312") || name.contains("GB18030");
    }
}
