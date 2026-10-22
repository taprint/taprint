/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import dev.taprint.barcode.BarcodeRenderer;
import dev.taprint.barcode.QrcodeRenderer;
import dev.taprint.core.KernelOptions;
import dev.taprint.dsl.LabelPresentation;
import dev.taprint.dsl.PageSpec;
import dev.taprint.dsl.ReceiptPresentation;
import dev.taprint.dsl.TableColumn;
import dev.taprint.core.CommandSet;
import dev.taprint.renderer.CpclRenderer;
import dev.taprint.renderer.CjkRasterizer;
import dev.taprint.renderer.DeviceProfile;
import dev.taprint.renderer.EscPosCapability;
import dev.taprint.renderer.EscPosRenderer;
import dev.taprint.renderer.EvaluatedElement;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.PrintImageLoader;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import dev.taprint.renderer.TsplRenderer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RendererByteStreamTest {

    private static final Charset GBK = Charset.forName("GBK");

    private EscPosRenderer escPosRenderer() {
        BarcodeRenderer barcodeRenderer = new BarcodeRenderer();
        return new EscPosRenderer(new QrcodeRenderer(barcodeRenderer),
                new PrintImageLoader(), new CjkRasterizer());
    }

    private RenderContext receiptCtx(EscPosCapability cap) {
        DeviceProfile profile = new DeviceProfile();
        profile.setEscPos(cap);
        return RenderContext.builder().copies(1).deviceProfile(profile).build();
    }

    private EvaluatedElement text(String content, String align) {
        EvaluatedElement el = new EvaluatedElement();
        el.setType("text");
        el.setText(content);
        el.setAlign(align);
        return el;
    }

    private EvaluatedTemplate receiptTemplate(List<EvaluatedElement> body) {
        EvaluatedTemplate t = new EvaluatedTemplate();
        ReceiptPresentation spec = new ReceiptPresentation();
        spec.setWidth("80mm");
        spec.setEncoding("gbk");
        t.setReceipt(spec);
        t.setBody(body);
        return t;
    }

    private String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02X ", b));
        }
        return sb.toString();
    }

    private boolean contains(byte[] haystack, byte[] needle) {
        outer:
        for (int i = 0; i <= haystack.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return true;
        }
        return false;
    }

    // ================= ESC/POS =================

    @Test
    @DisplayName("TC-ESC-001 初始化 + 单行文本 + 换行")
    void test_escInitAndText() {
        RenderResult result = escPosRenderer().render(
                receiptTemplate(Arrays.asList(text("Hello", "left"))),
                receiptCtx(EscPosCapability.defaults()));
        byte[] bytes = result.getPayload();
        assertEquals(CommandSet.ESC_POS, result.getCommandSet());
        assertTrue(contains(bytes, new byte[]{0x1B, 0x40}), "缺少 ESC @ 初始化");
        assertTrue(contains(bytes, "Hello".getBytes(GBK)));
        assertTrue(contains(bytes, new byte[]{0x0A}));
    }

    @Test
    @DisplayName("TC-ESC-002 中文 GBK 编码")
    void test_escChineseGbk() {
        RenderResult result = escPosRenderer().render(
                receiptTemplate(Arrays.asList(text("收银小票", "left"))),
                receiptCtx(EscPosCapability.defaults()));
        assertTrue(contains(result.getPayload(), "收银小票".getBytes(GBK)));
        // FS & 汉字模式开启
        assertTrue(contains(result.getPayload(), new byte[]{0x1C, 0x26}));
    }

    @Test
    @DisplayName("TC-ESC-003 居中对齐")
    void test_escCenter() {
        RenderResult result = escPosRenderer().render(
                receiptTemplate(Arrays.asList(text("X", "center"))),
                receiptCtx(EscPosCapability.defaults()));
        assertTrue(contains(result.getPayload(), new byte[]{0x1B, 0x61, 0x01}));
    }

    @Test
    @DisplayName("TC-ESC-004 字号双倍 0x11 + 粗体")
    void test_escDoubleFont() {
        EvaluatedElement el = text("T", "left");
        dev.taprint.dsl.DslStyle style =
                new dev.taprint.dsl.DslStyle();
        style.setFontSize("double");
        style.setBold(true);
        el.setStyle(style);
        RenderResult result = escPosRenderer().render(
                receiptTemplate(Arrays.asList(el)), receiptCtx(EscPosCapability.defaults()));
        assertTrue(contains(result.getPayload(), new byte[]{0x1D, 0x21, 0x11}), "缺少 GS ! 0x11");
        assertTrue(contains(result.getPayload(), new byte[]{0x1B, 0x45, 0x01}), "缺少 ESC E 1");
    }

    @Test
    @DisplayName("TC-ESC-005 表格按 profile 列数对齐")
    void test_escTableColumns() {
        EscPosCapability cap = EscPosCapability.defaults();
        cap.setMaxWidthCols(48);
        EvaluatedElement table = new EvaluatedElement();
        table.setType("table");
        table.setHeaders(Arrays.asList("商品", "金额"));
        TableColumn c1 = new TableColumn();
        c1.setHeader("商品");
        c1.setField("name");
        c1.setWidth("60%");
        TableColumn c2 = new TableColumn();
        c2.setHeader("金额");
        c2.setField("amount");
        c2.setWidth("40%");
        c2.setAlign("right");
        table.setColumns(Arrays.asList(c1, c2));
        List<List<String>> rows = new ArrayList<>();
        rows.add(Arrays.asList("苹果", "10.00"));
        table.setRows(rows);

        RenderResult result = escPosRenderer().render(
                receiptTemplate(Arrays.asList(table)), receiptCtx(cap));
        String out = new String(result.getPayload(), GBK);
        // 每行显示宽度 = 48 列（汉字占 2 列）
        String[] lines = out.split("\n");
        boolean found = false;
        for (String line : lines) {
            if (line.contains("10.00")) {
                assertEquals(48, dev.taprint.renderer.EscPosTextUtil.displayWidth(line.replace("\u0000", "")),
                        "表格行显示宽度应为 48 列: [" + line + "]");
                found = true;
            }
        }
        assertTrue(found, "未找到明细行");
    }

    @Test
    @DisplayName("TC-ESC-006 二维码原生 GS ( k 五步序列")
    void test_escQrNative() {
        EscPosCapability cap = EscPosCapability.defaults();
        cap.setNativeQrCode(true);
        EvaluatedElement qr = new EvaluatedElement();
        qr.setType("qrcode");
        qr.setText("ABC123");
        qr.setSize(6);
        RenderResult result = escPosRenderer().render(
                receiptTemplate(Arrays.asList(qr)), receiptCtx(cap));
        byte[] bytes = result.getPayload();
        assertTrue(contains(bytes, new byte[]{0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x02, 0x00}), "缺少模型设置");
        assertTrue(contains(bytes, new byte[]{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31}), "缺少纠错级别");
        assertTrue(contains(bytes, new byte[]{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30}), "缺少打印指令");
    }

    @Test
    @DisplayName("TC-ESC-007 二维码位图兜底 GS v 0")
    void test_escQrBitmapFallback() {
        EvaluatedElement qr = new EvaluatedElement();
        qr.setType("qrcode");
        qr.setText("ABC123");
        qr.setSize(4);
        RenderResult result = escPosRenderer().render(
                receiptTemplate(Arrays.asList(qr)), receiptCtx(EscPosCapability.defaults()));
        assertTrue(contains(result.getPayload(), new byte[]{0x1D, 'v', '0', 0x00}), "缺少 GS v 0");
    }

    @Test
    @DisplayName("TC-ESC-008/009 切纸与钱箱")
    void test_escCutAndDrawer() {
        EvaluatedElement cut = new EvaluatedElement();
        cut.setType("cut");
        cut.setPartial(true);
        EvaluatedElement drawer = new EvaluatedElement();
        drawer.setType("cashDrawer");
        drawer.setPulse(1);
        RenderResult result = escPosRenderer().render(
                receiptTemplate(Arrays.asList(drawer, cut)), receiptCtx(EscPosCapability.defaults()));
        byte[] bytes = result.getPayload();
        assertTrue(contains(bytes, new byte[]{0x1D, 0x56, 0x01}), "缺少半切");
        assertTrue(contains(bytes, new byte[]{0x1B, 0x70, 0x00}), "缺少钱箱脉冲");
    }

    @Test
    @DisplayName("TC-ESC-010 长文档 1000 行无溢出")
    void test_escLongDoc() {
        List<EvaluatedElement> body = new ArrayList<>();
        for (int i = 0; i < 1000; i++) {
            body.add(text("行" + i, "left"));
        }
        RenderResult result = escPosRenderer().render(receiptTemplate(body),
                receiptCtx(EscPosCapability.defaults()));
        assertTrue(result.getPayload().length > 10000);
    }

    // ================= TSPL =================

    private EvaluatedTemplate labelTemplate(List<EvaluatedElement> body) {
        EvaluatedTemplate t = new EvaluatedTemplate();
        LabelPresentation spec = new LabelPresentation();
        PageSpec size = new PageSpec();
        size.setWidth("60mm");
        size.setHeight("40mm");
        spec.setSize(size);
        spec.setGap("2mm");
        spec.setDensity(8);
        spec.setSpeed(4);
        t.setLabel(spec);
        t.setBody(body);
        return t;
    }

    private EvaluatedElement labelElement(String type, String content, String x, String y) {
        EvaluatedElement el = new EvaluatedElement();
        el.setType(type);
        el.setText(content);
        el.setX(x);
        el.setY(y);
        return el;
    }

    @Test
    @DisplayName("TSPL 头部序列 + TEXT 参数顺序 + PRINT n")
    void test_tspl() {
        List<EvaluatedElement> body = new ArrayList<>();
        body.add(labelElement("text", "你好", "5mm", "5mm"));
        RenderResult result = new TsplRenderer(new PrintImageLoader(), new CjkRasterizer())
                .render(labelTemplate(body),
                RenderContext.builder().copies(2).build());
        String out = new String(result.getPayload(), GBK);
        assertEquals(CommandSet.TSPL, result.getCommandSet());
        assertTrue(out.contains("SIZE 60 mm,40 mm"), out);
        assertTrue(out.contains("GAP 2 mm,0 mm"), out);
        assertTrue(out.contains("DENSITY 8"), out);
        assertTrue(out.contains("CLS"), out);
        assertTrue(out.contains("TEXT 40,40,\"SIMPLIFIED CHINESE\",0,1,1,\"你好\""),
                "TEXT 顺序应为 x,y,font,rotation,x-mul,y-mul,content: " + out);
        assertTrue(out.contains("PRINT 2"), out);
    }

    @Test
    @DisplayName("TSPL BARCODE/QRCODE 指令")
    void test_tsplCodes() {
        List<EvaluatedElement> body = new ArrayList<>();
        EvaluatedElement barcode = labelElement("barcode", "12345", "5mm", "20mm");
        barcode.setSymbology("CODE128");
        barcode.setHeight("10mm");
        EvaluatedElement qr = labelElement("qrcode", "https://x.cn", "5mm", "30mm");
        qr.setSize(6);
        body.add(barcode);
        body.add(qr);
        RenderResult result = new TsplRenderer(new PrintImageLoader(), new CjkRasterizer())
                .render(labelTemplate(body),
                RenderContext.builder().copies(1).build());
        String out = new String(result.getPayload(), GBK);
        assertTrue(out.contains("BARCODE 40,160,\"128\",80,1,0,2,2,\"12345\""), out);
        assertTrue(out.contains("QRCODE 40,240,M,6,A,0,M2,\"https://x.cn\""), out);
    }

    // ================= CPCL =================

    @Test
    @DisplayName("CPCL 格式头/TEXT/三段式 QR/FORM/PRINT")
    void test_cpcl() {
        CjkRasterizer rasterizer = new CjkRasterizer();
        CpclRenderer renderer = new CpclRenderer(rasterizer, new PrintImageLoader());
        List<EvaluatedElement> body = new ArrayList<>();
        body.add(labelElement("text", "HELLO", "5mm", "5mm"));
        EvaluatedElement barcode = labelElement("barcode", "12345", "5mm", "15mm");
        barcode.setSymbology("CODE128");
        barcode.setHeight("10mm");
        EvaluatedElement qr = labelElement("qrcode", "DATA", "5mm", "28mm");
        qr.setSize(7);
        body.add(barcode);
        body.add(qr);
        RenderResult result = renderer.render(labelTemplate(body),
                RenderContext.builder().copies(2).build());
        String out = new String(result.getPayload(), java.nio.charset.StandardCharsets.US_ASCII);
        assertEquals(CommandSet.CPCL, result.getCommandSet());
        assertTrue(out.startsWith("! 0 200 200 320 2"), "格式头应为 ! offset horz vert height qty: " + out);
        assertTrue(out.contains("TEXT 4 0 40 40 HELLO"), out);
        assertTrue(out.contains("BARCODE 128 2 1 80 40 120 12345"), out);
        assertTrue(out.contains("BARCODE QR 40 224 M 2 U 7"), out);
        assertTrue(out.contains("M0A,DATA"), "数据行应为三字符形态 M0A,data");
        assertTrue(out.contains("ENDQR"), out);
        assertTrue(out.contains("FORM"), out);
        assertTrue(out.endsWith("PRINT\r\n"), out);
    }
}
