/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import dev.taprint.barcode.Symbology;
import dev.taprint.core.CommandSet;
import dev.taprint.core.PrintErrorCode;
import dev.taprint.core.PrintKernelException;
import dev.taprint.dsl.LabelPresentation;

import java.nio.charset.Charset;

/**
 * ZPL 标签渲染器（v0.2 内置字库路由，ADR-0001）。
 *
 * <p>移植参照：提取源工程的 {@code modules/print/renderer/ZplRenderer.java}
 * （自研，主文档 §7.7）。v0.2 收编口径（ADR-0001：ZPL 首发走内置字库/ASCII 路由）：
 * <ul>
 *   <li>文本一律 {@code ^A0N,h,w} 内置字库路由，CJK 位图路由（^GFA + CjkRasterizer，
 *       与预览引擎共享光栅）按 ADR-0001 留给 v0.2.x 增量、自带 ADR——本版不发；</li>
 *   <li>内容通道按内核纪律走 GBK 表 + U+FFFD 占位（ADR-0009 §3，GbEncoding），
 *       参照实现的 {@code ^CI28}（UTF-8 通道）被替换——四语言字节级对拍前提，
 *       差异登记 docs/conformance.md；</li>
 *   <li>外部 Labelary 兜底（含 PII 白名单）随外部服务红线整体退役，本地预览
 *       走 {@link ZplPreviewer}（纯 Java 光栅，零外呼）。</li>
 * </ul>
 *
 * <p>帧骨架：{@code ^XA^LH0,0^PW<w>^LL<h> → 元素 → [^PQ<n>] → ^XZ}；元素面 =
 * text/barcode/qrcode/line/rect（image 与 ^GFA 同批延后 v0.2.x，抛
 * UNSUPPORTED_ELEMENT）。
 */
public class ZplRenderer implements Renderer {

    /** ^A0 内置字库基准字高（dot）；倍率域 1-10（参照实现同口径）。 */
    static final int ASCII_FONT_HEIGHT = 28;

    /** 框线厚度缺省（dot）——TSPL/CPCL Java 参照同档 2。 */
    private static final int BOX_THICKNESS = 2;

    private static final Charset GBK = Charset.forName("GBK");

    @Override
    public CommandSet getCommandSet() {
        return CommandSet.ZPL;
    }

    @Override
    public RenderResult render(EvaluatedTemplate evaluated, RenderContext ctx) {
        checkInterrupted();
        LabelPresentation spec = evaluated.getLabel();
        StringBuilder zpl = new StringBuilder(2048);
        try {
            int widthDots = LengthUtil.mmToDots(spec.getSize().getWidth(), 60);
            int heightDots = LengthUtil.mmToDots(spec.getSize().getHeight(), 40);
            zpl.append("^XA");
            zpl.append("^LH0,0");
            zpl.append("^PW").append(widthDots);
            zpl.append("^LL").append(heightDots);

            for (EvaluatedElement el : evaluated.getBody()) {
                checkInterrupted();
                renderElement(zpl, el);
            }

            int copies = Math.max(1, ctx.getCopies());
            if (copies > 1) {
                zpl.append("^PQ").append(copies);
            }
            zpl.append("^XZ");
        } catch (PrintKernelException e) {
            throw timeoutIfInterrupted(e);
        } catch (Exception e) {
            throw timeoutIfInterrupted(PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_FAILED)
                    .message("ZPL 渲染失败: " + e.getMessage())
                    .cause(e)
                    .build());
        }
        checkInterrupted();
        // ADR-0009 §3：内容通道按 GBK 表编码，表外字符以 U+FFFD 占位
        // （EF BF BD，与 TSPL/CPCL/Dart/TS 端同口径）；帧结构字符（^ 与参数）
        // 均为 ASCII，GBK 编码下逐字节不变。
        return new RenderResult(GbEncoding.encodeWithReplacement(zpl.toString(), GBK),
                "application/octet-stream", CommandSet.ZPL);
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

    /**
     * 元素级中断检查点（§22-1 渲染超时孤儿任务可中断化——CPU 密集段无法硬杀，
     * 元素边界足够；超时后 Future.cancel(true) 在下一元素边界抛 RENDER_TIMEOUT）。
     */
    private static void checkInterrupted() {
        if (Thread.interrupted()) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.RENDER_TIMEOUT)
                    .message("渲染线程已中断（超时取消）")
                    .build();
        }
    }

    private void renderElement(StringBuilder zpl, EvaluatedElement el) {
        String type = el.getType();
        if (type == null) {
            return;
        }
        int x = LengthUtil.mmToDots(el.getX(), 0);
        int y = LengthUtil.mmToDots(el.getY(), 0);
        switch (type) {
            case "text":
                renderText(zpl, el, x, y);
                break;
            case "barcode":
                renderBarcode(zpl, el, x, y);
                break;
            case "qrcode":
                renderQrcode(zpl, el, x, y);
                break;
            case "line":
                renderLine(zpl, el, x, y);
                break;
            case "rect":
                renderRect(zpl, el, x, y);
                break;
            default:
                // image 与 CJK 位图路由同批延后 v0.2.x（ADR-0001），fail-fast。
                throw PrintKernelException.builder()
                        .errorCode(PrintErrorCode.UNSUPPORTED_ELEMENT)
                        .message("label 呈现不支持元素类型: " + type)
                        .build();
        }
    }

    /**
     * 文本：逐行 {@code ^FOx,y^A0N,h,h^FD<escaped>^FS}，h = 28 × 倍率
     * （倍率域 1-10；行距即字高，多行 y 逐行递增）。CJK 内容同样走内置字库
     * 路由（v0.2 口径）；位图路由见 ADR-0001 v0.2.x 增量。
     */
    private void renderText(StringBuilder zpl, EvaluatedElement el, int x, int y) {
        String content = el.getText() == null ? "" : el.getText();
        if (content.isEmpty()) {
            return;
        }
        int mul = el.getSize() == null ? 1 : Math.max(1, Math.min(10, el.getSize()));
        int lineNo = 0;
        for (String line : content.split("\n", -1)) {
            int h = ASCII_FONT_HEIGHT * mul;
            zpl.append("^FO").append(x).append(',').append(y + lineNo * h)
                    .append("^A0N,").append(h).append(',').append(h)
                    .append("^FD").append(escapeZpl(line)).append("^FS");
            lineNo++;
        }
    }

    /**
     * 一维码：{@code ^FOx,y^BY2,3,<h><码制>^FD<escaped>^FS}（窄条 2 dot、
     * 宽窄比 3，参照实现同口径）。码制表：CODE128→^BCN、EAN13/EAN8→^BEN、
     * UPC→^BUN、CODE39→^B3N、ITF→^B2N；未知码制按 Symbology.of 折 CODE128
     * （参照实现口径，登记 conformance.md）。
     */
    private void renderBarcode(StringBuilder zpl, EvaluatedElement el, int x, int y) {
        String content = el.getText() == null ? "" : el.getText();
        if (content.isEmpty()) {
            return;
        }
        Symbology symbology = Symbology.of(el.getSymbology());
        int height = LengthUtil.mmToDots(el.getHeight(), 10);
        zpl.append("^FO").append(x).append(',').append(y);
        zpl.append("^BY2,3,").append(height);
        switch (symbology) {
            case EAN13:
                zpl.append("^BEN,").append(height).append(",Y,N,N");
                break;
            case EAN8:
                zpl.append("^BEN,").append(height).append(",Y,N");
                break;
            case UPC:
                zpl.append("^BUN,").append(height).append(",Y,N");
                break;
            case CODE39:
                zpl.append("^B3N,N,").append(height).append(",Y,N");
                break;
            case ITF:
                zpl.append("^B2N,").append(height).append(",N,N");
                break;
            case CODE128:
            default:
                zpl.append("^BCN,").append(height).append(",Y,N,N");
                break;
        }
        zpl.append("^FD").append(escapeZpl(content)).append("^FS");
    }

    /** QR：{@code ^FOx,y^BQN,2,<size>^FDMA,<escaped>^FS}（型号 2、纠错 M +
     * 掩码自动 = "MA" 前缀；size 域 1-10 缺省 6，参照实现同口径）。 */
    private void renderQrcode(StringBuilder zpl, EvaluatedElement el, int x, int y) {
        String content = el.getText() == null ? "" : el.getText();
        if (content.isEmpty()) {
            return;
        }
        int size = el.getSize() == null ? 6 : Math.max(1, Math.min(10, el.getSize()));
        zpl.append("^FO").append(x).append(',').append(y)
                .append("^BQN,2,").append(size)
                .append("^FDMA,").append(escapeZpl(content)).append("^FS");
    }

    /**
     * 水平线：{@code ^FOx,y^GB<w>,<h>,2^FS}（线 = 细框；长度 w = width 折算
     * 缺省 50mm，线高 h = height 折算下夹厚度 2——零高度框无 ZPL 语义）。
     */
    private void renderLine(StringBuilder zpl, EvaluatedElement el, int x, int y) {
        int w = LengthUtil.mmToDots(el.getWidth(), 50);
        int h = Math.max(BOX_THICKNESS, LengthUtil.mmToDots(el.getHeight(), 0));
        appendBox(zpl, x, y, w, h);
    }

    /** 矩形框：{@code ^FOx,y^GB<w>,<h>,2^FS}（宽缺省 30mm、高缺省 20mm）。 */
    private void renderRect(StringBuilder zpl, EvaluatedElement el, int x, int y) {
        int w = LengthUtil.mmToDots(el.getWidth(), 30);
        int h = LengthUtil.mmToDots(el.getHeight(), 20);
        appendBox(zpl, x, y, w, h);
    }

    private static void appendBox(StringBuilder zpl, int x, int y, int w, int h) {
        zpl.append("^FO").append(x).append(',').append(y)
                .append("^GB").append(w).append(',').append(h).append(',').append(BOX_THICKNESS)
                .append("^FS");
    }

    /**
     * ZPL 转义：^ ~ 为指令前缀，FD 内需转义为 \^ \~；反斜杠先行转义。
     * （参照实现口径——ZPL II 手册 ^FD 域转义子集。）
     */
    static String escapeZpl(String s) {
        return s.replace("\\", "\\\\").replace("^", "\\^").replace("~", "\\~");
    }
}
