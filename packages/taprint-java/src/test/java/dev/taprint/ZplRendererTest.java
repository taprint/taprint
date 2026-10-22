/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import dev.taprint.core.DeviceClass;
import dev.taprint.core.PrintErrorCode;
import dev.taprint.core.PrintKernelException;
import dev.taprint.renderer.CjkRasterizer;
import dev.taprint.renderer.EvaluatedElement;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.PrintImageLoader;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import dev.taprint.renderer.ZplPreviewer;
import dev.taprint.renderer.ZplRenderer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.nio.charset.Charset;
import java.util.Arrays;
import java.util.Collections;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ZPL 渲染器与本地预览器（v0.2 内置字库路由，ADR-0001）：
 * 帧骨架序、^FD 转义、码制表、QR 三段、框线、份数、表外字符 U+FFFD 占位、
 * 舍入中点、不支持元素 fail-fast；预览器 PNG 魔数/画幅/位图落点。
 */
class ZplRendererTest {

    private static final Charset GBK = Charset.forName("GBK");

    private final ZplRenderer renderer = new ZplRenderer();

    // ---- 帧骨架 ----

    @Test
    @DisplayName("帧序：^XA→^LH0,0→^PW→^LL→元素→^XZ（无 ^PQ 当份数=1）")
    void frameOrderHeaderBodyTail() {
        RenderResult result = renderer.render(labelTemplate(text("HELLO", "4mm", "18mm", 1)),
                RenderContext.builder().copies(1).build());
        String zpl = new String(result.getPayload(), GBK);
        assertEquals("^XA^LH0,0^PW480^LL320^FO32,144^A0N,28,28^FDHELLO^FS^XZ", zpl);
        assertEquals("application/octet-stream", result.getMimeType());
        assertFalse(zpl.contains("^PQ"));
    }

    @Test
    @DisplayName("份数 >1 时发 ^PQ 且紧邻 ^XZ 之前")
    void copiesEmittedAsPq() {
        RenderResult result = renderer.render(labelTemplate(text("BATCH", "4mm", "18mm", 1)),
                RenderContext.builder().copies(3).build());
        String zpl = new String(result.getPayload(), GBK);
        assertTrue(zpl.endsWith("^PQ3^XZ"));
    }

    @Test
    @DisplayName("多行文本逐行 ^FD、行距 = 字高（size 2 → 行高 56）")
    void multilineTextAdvancesByFontHeight() {
        RenderResult result = renderer.render(labelTemplate(text("LINE-A\nLINE-B", "4mm", "4mm", 2)),
                RenderContext.builder().copies(1).build());
        String zpl = new String(result.getPayload(), GBK);
        assertEquals("^XA^LH0,0^PW480^LL320"
                + "^FO32,32^A0N,56,56^FDLINE-A^FS"
                + "^FO32,88^A0N,56,56^FDLINE-B^FS^XZ", zpl);
    }

    @Test
    @DisplayName("字号倍率域夹取 1-10（15 → 10 → 字高 280）")
    void sizeMultiplierClamped() {
        RenderResult result = renderer.render(labelTemplate(text("X", "0mm", "0mm", 15)),
                RenderContext.builder().copies(1).build());
        String zpl = new String(result.getPayload(), GBK);
        assertTrue(zpl.contains("^A0N,280,280"));
    }

    // ---- 转义 ----

    @Test
    @DisplayName("^FD 域转义：^ ~ → \\^ \\~，反斜杠先行")
    void fieldDataEscapesControlPrefixes() {
        RenderResult result = renderer.render(labelTemplate(text("a^b~c\\d", "0mm", "0mm", 1)),
                RenderContext.builder().copies(1).build());
        String zpl = new String(result.getPayload(), GBK);
        assertTrue(zpl.contains("^FDa\\^b\\~c\\\\d^FS"));
    }

    // ---- 码制 ----

    @Test
    @DisplayName("CODE128 → ^BY2,3,<h> + ^BCN,h,Y,N,N")
    void barcodeCode128() {
        RenderResult result = renderer.render(labelTemplate(
                barcode("SKU-100086", "CODE128", "4mm", "22mm", "10mm")),
                RenderContext.builder().copies(1).build());
        String zpl = new String(result.getPayload(), GBK);
        assertTrue(zpl.contains("^FO32,176^BY2,3,80^BCN,80,Y,N,N^FDSKU-100086^FS"));
    }

    @Test
    @DisplayName("EAN13 → ^BEN,h,Y,N,N；未知码制折 CODE128（参照 Symbology.of 口径）")
    void barcodeEan13AndUnknownFoldsToCode128() {
        String ean = zplOf(labelTemplate(barcode("6901234567892", "EAN13", "4mm", "22mm", "10mm")));
        assertTrue(ean.contains("^BEN,80,Y,N,N"));
        String folded = zplOf(labelTemplate(barcode("X1", "PDF417", "4mm", "22mm", "10mm")));
        assertTrue(folded.contains("^BCN,80,Y,N,N"));
    }

    // ---- QR ----

    @Test
    @DisplayName("QR → ^BQN,2,<size>^FDMA,<data>^FS（size 缺省 6、域 1-10）")
    void qrThreeSegmentForm() {
        String zpl = zplOf(labelTemplate(qrcode("TAPRINT", "20mm", "10mm", 6)));
        assertTrue(zpl.contains("^FO160,80^BQN,2,6^FDMA,TAPRINT^FS"));
        String clamped = zplOf(labelTemplate(qrcode("TAPRINT", "20mm", "10mm", 99)));
        assertTrue(clamped.contains("^BQN,2,10"));
    }

    // ---- 框线 ----

    @Test
    @DisplayName("line → 细框 ^GB<w>,<h>,2（线高下夹厚度）；rect → ^GB<w>,<h>,2")
    void lineAndRectUseGraphicBox() {
        EvaluatedTemplate t = labelTemplate(null);
        t.setBody(Arrays.asList(line("2mm", "34mm", "56mm", "0.5mm"), rect("2mm", "2mm", "56mm", "36mm")));
        String zpl = zplOf(t);
        // 0.5mm→4dot、56mm→448dot（203dpi≈7.9921dot/mm）
        assertTrue(zpl.contains("^FO16,272^GB448,4,2^FS"));
        assertTrue(zpl.contains("^FO16,16^GB448,288,2^FS"));
    }

    // ---- 舍入 / 表外字符 ----

    @Test
    @DisplayName("mm→dot 折算（6.35mm→51dot @203dpi）与表外字符 U+FFFD 占位")
    void dotConversionAndUnmappedPlaceholder() {
        String zpl = zplOf(labelTemplate(text("MID", "6.35mm", "0mm", 1)));
        assertTrue(zpl.contains("^FO51,0"));
        RenderResult unmapped = renderer.render(labelTemplate(text("ID😀42", "0mm", "0mm", 1)),
                RenderContext.builder().copies(1).build());
        byte[] payload = unmapped.getPayload();
        int at = indexOf(payload, new byte[]{(byte) 0xEF, (byte) 0xBF, (byte) 0xBD});
        assertTrue(at > 0, "应包含 U+FFFD 字节 EF BF BD");
        // 帧结构 ASCII 不受内容通道影响
        assertTrue(new String(payload, GBK).startsWith("^XA"));
    }

    // ---- 不支持元素 ----

    @Test
    @DisplayName("image 元素 v0.2 不支持 → UNSUPPORTED_ELEMENT fail-fast")
    void unsupportedElementFailsFast() {
        EvaluatedElement image = new EvaluatedElement();
        image.setType("image");
        image.setText("data:image/png;base64,AAAA");
        image.setX("0mm");
        image.setY("0mm");
        PrintKernelException e = assertThrows(PrintKernelException.class,
                () -> renderer.render(labelTemplate(image), RenderContext.builder().copies(1).build()));
        assertEquals(PrintErrorCode.UNSUPPORTED_ELEMENT, e.getErrorCode());
    }

    @Test
    @DisplayName("空文本/空条码元素整体跳过（不发空 ^FD 帧）")
    void emptyContentSkipped() {
        String zpl = zplOf(labelTemplate(text("", "0mm", "0mm", 1)));
        assertEquals("^XA^LH0,0^PW480^LL320^XZ", zpl);
    }

    // ---- 本地预览器（ZPL→PNG，纯 Java 光栅） ----

    @Test
    @DisplayName("预览器：PNG 魔数 + ^PW/^LL 画幅 + 可被 ImageIO 解码")
    void previewerEmitsDecodablePng() throws Exception {
        ZplPreviewer previewer = new ZplPreviewer();
        byte[] png = previewer.renderToPng("^XA^LH0,0^PW480^LL320"
                + "^FO32,32^A0N,28,28^FDHELLO^FS^XZ");
        assertEquals(0x89, png[0] & 0xFF);
        assertEquals('P', png[1]);
        assertEquals('N', png[2]);
        assertEquals('G', png[3]);
        BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
        assertNotNull(image);
        assertEquals(480, image.getWidth());
        assertEquals(320, image.getHeight());
    }

    @Test
    @DisplayName("预览器：^GB 框落墨、^GFA 位图解码、缺 ^XA 拒绝")
    void previewerDrawsBoxGfaAndRejectsMissingFrame() {
        ZplPreviewer previewer = new ZplPreviewer();
        BufferedImage boxed = ImageIOHolder.read(
                previewer.renderToPng("^XA^LH0,0^PW100^LL100^FO10,10^GB50,50,3^FS^XZ"));
        assertNotNull(boxed);
        // 框上沿（厚度 3，内缩描边）应为暗色
        int dark = 0;
        for (int x = 12; x < 58; x++) {
            if (luma(boxed, x, 11) < 128) {
                dark++;
            }
        }
        assertTrue(dark > 30, "框上沿应连续落墨: " + dark);

        // ^GFA：2×2 位图，字节 0xC0 = 两暗点（MSB 在左）
        BufferedImage gfa = ImageIOHolder.read(
                previewer.renderToPng("^XA^LH0,0^PW100^LL100^FO5,5^GFA,4,4,2,C000C000^FS^XZ"));
        assertNotNull(gfa);
        assertTrue(luma(gfa, 5, 5) < 128, "^GFA 首位应落墨");
        assertTrue(luma(gfa, 6, 6) < 128, "^GFA 次行首位应落墨");
        assertTrue(luma(gfa, 7, 5) >= 128, "补零位不应落墨");

        assertThrows(PrintKernelException.class, () -> previewer.renderToPng("^FDno-frame^FS"));
    }

    // ---- 工具 ----

    private static int luma(BufferedImage image, int x, int y) {
        return image.getRGB(x, y) & 0xFF;
    }

    private static int indexOf(byte[] haystack, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= haystack.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }

    private String zplOf(EvaluatedTemplate template) {
        return new String(renderer.render(template, RenderContext.builder().copies(1).build())
                .getPayload(), GBK);
    }

    private static EvaluatedElement text(String content, String x, String y, Integer size) {
        EvaluatedElement el = new EvaluatedElement();
        el.setType("text");
        el.setText(content);
        el.setX(x);
        el.setY(y);
        el.setSize(size);
        return el;
    }

    private static EvaluatedElement barcode(String content, String symbology, String x, String y, String height) {
        EvaluatedElement el = new EvaluatedElement();
        el.setType("barcode");
        el.setText(content);
        el.setSymbology(symbology);
        el.setX(x);
        el.setY(y);
        el.setHeight(height);
        return el;
    }

    private static EvaluatedElement qrcode(String content, String x, String y, Integer size) {
        EvaluatedElement el = new EvaluatedElement();
        el.setType("qrcode");
        el.setText(content);
        el.setX(x);
        el.setY(y);
        el.setSize(size);
        return el;
    }

    private static EvaluatedElement line(String x, String y, String width, String height) {
        EvaluatedElement el = new EvaluatedElement();
        el.setType("line");
        el.setX(x);
        el.setY(y);
        el.setWidth(width);
        el.setHeight(height);
        return el;
    }

    private static EvaluatedElement rect(String x, String y, String width, String height) {
        EvaluatedElement el = new EvaluatedElement();
        el.setType("rect");
        el.setX(x);
        el.setY(y);
        el.setWidth(width);
        el.setHeight(height);
        return el;
    }

    private EvaluatedTemplate labelTemplate(EvaluatedElement element) {
        EvaluatedTemplate template = new EvaluatedTemplate();
        template.setDeviceClass(DeviceClass.LABEL);
        dev.taprint.dsl.LabelPresentation label = new dev.taprint.dsl.LabelPresentation();
        dev.taprint.dsl.PageSpec size = new dev.taprint.dsl.PageSpec();
        size.setWidth("60mm");
        size.setHeight("40mm");
        label.setSize(size);
        label.setGap("2mm");
        template.setLabel(label);
        template.setBody(element == null
                ? Collections.emptyList() : Collections.singletonList(element));
        return template;
    }

    /** ImageIO.read 的受检异常包装（测试内使用）。 */
    private static final class ImageIOHolder {
        private static BufferedImage read(byte[] png) {
            try {
                return ImageIO.read(new ByteArrayInputStream(png));
            } catch (java.io.IOException e) {
                throw new IllegalStateException(e);
            }
        }
    }
}
