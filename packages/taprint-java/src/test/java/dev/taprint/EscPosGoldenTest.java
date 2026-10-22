/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import dev.taprint.barcode.BarcodeRenderer;
import dev.taprint.barcode.QrcodeRenderer;
import dev.taprint.dsl.TemplateDsl;
import dev.taprint.core.DeviceClass;
import dev.taprint.expression.PrintExpressionEvaluator;
import dev.taprint.renderer.DeviceProfile;
import dev.taprint.renderer.EscPosCapability;
import dev.taprint.renderer.EscPosRenderer;
import dev.taprint.renderer.CjkRasterizer;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.PrintImageLoader;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * → 表达式求值 → ESC/POS 渲染 → 字节级 sha256 比对。
 *
 */
class EscPosGoldenTest {

    private static final String GOLDEN_PATH = "src/test/resources/print/golden/esc-pos-receipt.golden.sha256";

    @Test
    @DisplayName("销售小票 ESC/POS 字节流 golden（sha256 字节级）")
    void test_goldenBytes() throws Exception {
        TemplateDsl dsl = PrintTestFixturetures.loadDsl("print/fixtures/esc-pos-receipt-v1.0.json");
        Map<String, Object> data = PrintTestFixturetures.escPosReceiptMockData();

        PrintExpressionEvaluator evaluator = PrintTestFixturetures.newEvaluator();
        EvaluatedTemplate evaluated = evaluator.eval(dsl, DeviceClass.RECEIPT, data);

        BarcodeRenderer barcodeRenderer = new BarcodeRenderer();
        EscPosRenderer renderer = new EscPosRenderer(new QrcodeRenderer(barcodeRenderer),
                new PrintImageLoader(), new CjkRasterizer());
        DeviceProfile profile = new DeviceProfile();
        EscPosCapability cap = EscPosCapability.defaults();
        cap.setMaxWidthCols(48);
        profile.setEscPos(cap);
        RenderResult result = renderer.render(evaluated,
                RenderContext.builder().copies(1).deviceProfile(profile).build());

        assertNotNull(result.getPayload());
        String actual = sha256(result.getPayload());

        File goldenFile = new File(GOLDEN_PATH);
        if (!goldenFile.exists()) {
            goldenFile.getParentFile().mkdirs();
            FileOutputStream fos = new FileOutputStream(goldenFile);
            fos.write((actual + "\n").getBytes(StandardCharsets.UTF_8));
            fos.close();
            System.out.println("[golden] 已生成: " + actual);
            return;
        }
        String expected = PrintTestFixturetures.readResource("print/golden/esc-pos-receipt.golden.sha256").trim();
        assertEquals(expected, actual, "ESC/POS 字节流 golden mismatch - rendering changed, update the golden deliberately");
    }

    private String sha256(byte[] bytes) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] digest = md.digest(bytes);
        StringBuilder sb = new StringBuilder();
        for (byte b : digest) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }
}
