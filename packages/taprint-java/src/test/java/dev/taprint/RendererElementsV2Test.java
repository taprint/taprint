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
import dev.taprint.core.CommandSet;
import dev.taprint.renderer.CjkRasterizer;
import dev.taprint.renderer.CpclRenderer;
import dev.taprint.renderer.DeviceProfile;
import dev.taprint.renderer.EscPosCapability;
import dev.taprint.renderer.EscPosRenderer;
import dev.taprint.renderer.EvaluatedElement;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.PrintImageLoader;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import dev.taprint.renderer.TsplRenderer;
import dev.taprint.font.PreviewFonts;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * image rendering across command sets: ESC/POS GS v 0 and TSPL LINE/BOX bits.
 */
class RendererElementsV2Test {

    private static final Charset GBK = Charset.forName("GBK");
    private static CjkRasterizer rasterizer;
    private static PrintImageLoader imageLoader;

    @BeforeAll
    static void setup() {
        rasterizer = new CjkRasterizer();
        imageLoader = new PrintImageLoader();
    }

    /** 16×8 位图（左半黑右半白）→ data URI */
    private static String blackLeftDataUri() {
        BufferedImage img = new BufferedImage(16, 8, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = img.createGraphics();
        try {
            g.setColor(Color.WHITE);
            g.fillRect(0, 0, 16, 8);
            g.setColor(Color.BLACK);
            g.fillRect(0, 0, 8, 8);
        } finally {
            g.dispose();
        }
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            ImageIO.write(img, "png", out);
            return "data:image/png;base64," + Base64.getEncoder().encodeToString(out.toByteArray());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static EvaluatedElement imageElement(String src, String x, String y) {
        EvaluatedElement el = new EvaluatedElement();
        el.setType("image");
        el.setText(src);
        el.setX(x);
        el.setY(y);
        return el;
    }

    private static EvaluatedTemplate labelTemplate(List<EvaluatedElement> body) {
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

    private static EvaluatedTemplate receiptTemplate(List<EvaluatedElement> body) {
        EvaluatedTemplate t = new EvaluatedTemplate();
        ReceiptPresentation spec = new ReceiptPresentation();
        spec.setWidth("80mm");
        spec.setEncoding("gbk");
        t.setReceipt(spec);
        t.setBody(body);
        return t;
    }

    @Test
    @DisplayName("B1 ESC/POS image → GS v 0 光栅位图（头 + 字节行）")
    void test_escposImage() {
        EscPosRenderer renderer = new EscPosRenderer(
                new QrcodeRenderer(new BarcodeRenderer()), imageLoader, rasterizer);
        List<EvaluatedElement> body = new ArrayList<>();
        body.add(imageElement(blackLeftDataUri(), null, null));
        DeviceProfile profile = new DeviceProfile();
        EscPosCapability cap = EscPosCapability.defaults();
        cap.setMaxWidthCols(48);
        profile.setEscPos(cap);
        RenderResult result = renderer.render(receiptTemplate(body),
                RenderContext.builder().copies(1).deviceProfile(profile).build());
        byte[] payload = result.getPayload();
        assertEquals(CommandSet.ESC_POS, result.getCommandSet());
        // GS v 0 头位于 INIT/汉字模式/对齐字节之后：1D 76 30 00 xL xH yL yH
        byte[] header = {0x1D, 'v', '0', 0, 2, 0, 8, 0};
        int idx = indexOf(payload, header);
        assertTrue(idx >= 0, "未找到 GS v 0 光栅位图头: " + hex(payload));
        // 数据 2×8=16 字节；左半黑 → 首字节 0xFF，右半白 → 第二字节 0x00
        assertEquals(0xFF, payload[idx + header.length] & 0xFF);
        assertEquals(0x00, payload[idx + header.length + 1] & 0xFF);
    }

    private static int indexOf(byte[] haystack, byte[] needle) {
        outer:
        for (int i = 0; i <= haystack.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02X", b));
        }
        return sb.toString();
    }

    @Test
    @DisplayName("B2 TSPL image → BITMAP（二进制字节，非 hex）")
    void test_tsplImageBitmap() {
        TsplRenderer renderer = new TsplRenderer(imageLoader, rasterizer);
        List<EvaluatedElement> body = new ArrayList<>();
        body.add(imageElement(blackLeftDataUri(), "5mm", "5mm"));
        RenderResult result = renderer.render(labelTemplate(body),
                RenderContext.builder().copies(1).build());
        String text = new String(result.getPayload(), GBK);
        // 5mm→40dot；16px→2 字节/行；8 行 → BITMAP 40,40,2,8,0,
        int prefixIdx = text.indexOf("BITMAP 40,40,2,8,0,");
        assertTrue(prefixIdx >= 0, text);
        byte[] payload = result.getPayload();
        int dataStart = prefixIdx + "BITMAP 40,40,2,8,0,".length();
        // 数据为二进制：首字节 0xFF（左半黑）、第二字节 0x00（右半白）
        assertEquals(0xFF, payload[dataStart] & 0xFF);
        assertEquals(0x00, payload[dataStart + 1] & 0xFF);
        // 总数据 16 字节后为 CRLF
        assertEquals('\r', payload[dataStart + 16] & 0xFF);
        assertEquals('\n', payload[dataStart + 17] & 0xFF);
    }

    @Test
    @DisplayName("B2 CPCL image → EG hex 位图")
    void test_cpclImageEg() {
        CpclRenderer renderer = new CpclRenderer(rasterizer, imageLoader);
        List<EvaluatedElement> body = new ArrayList<>();
        body.add(imageElement(blackLeftDataUri(), "5mm", "5mm"));
        RenderResult result = renderer.render(labelTemplate(body),
                RenderContext.builder().copies(1).build());
        String out = new String(result.getPayload(), StandardCharsets.US_ASCII);
        // EG widthBytes height x y hex
        assertTrue(out.contains("EG 2 8 40 40 FF00FF00FF00FF00FF00FF00FF00FF00"), out);
    }

    @Test
    @DisplayName("B3 TSPL line/rect → LINE/BOX 指令")
    void test_tsplLineBox() {
        TsplRenderer renderer = new TsplRenderer(imageLoader, rasterizer);
        List<EvaluatedElement> body = new ArrayList<>();
        EvaluatedElement line = imageElement("", "5mm", "5mm");
        line.setType("line");
        line.setWidth("50mm");
        body.add(line);
        EvaluatedElement rect = imageElement("", "5mm", "10mm");
        rect.setType("rect");
        rect.setWidth("30mm");
        rect.setHeight("20mm");
        body.add(rect);
        RenderResult result = renderer.render(labelTemplate(body),
                RenderContext.builder().copies(1).build());
        String out = new String(result.getPayload(), GBK);
        // LINE x1,y1,x2,y2,thickness（线宽 2 dot；5mm→40，宽 50mm→400 → x2=440）
        assertTrue(out.contains("LINE 40,40,440,40,2"), out);
        // BOX x1,y1,x2,y2,thickness（5mm→40；宽 30mm→240 → 280；高 20mm→160 → 240）
        assertTrue(out.contains("BOX 40,80,280,240,2"), out);
    }

}
