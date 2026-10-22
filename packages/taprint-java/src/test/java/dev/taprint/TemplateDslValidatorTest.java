/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import dev.taprint.validation.TemplateDslValidator;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * TemplateDslValidator 测试（C8 Acceptance：17 个 negative fixture 全拒 + 原因断言）。
 */
public class TemplateDslValidatorTest {

    private TemplateDslValidator validator;
    private static final Path NEGATIVE_DIR = Paths.get("src/test/resources/print/negative");

    @BeforeEach
    public void setUp() {
        validator = new TemplateDslValidator();
    }

    private String readFixture(String name) throws IOException {
        return new String(Files.readAllBytes(NEGATIVE_DIR.resolve(name)), StandardCharsets.UTF_8);
    }

    private void assertRejected(String fixture, String... keywords) throws IOException {
        List<String> errors = validator.validateJson(readFixture(fixture));
        assertFalse(errors.isEmpty(), fixture + " 应被拒，实际 errors 为空");
        if (keywords != null && keywords.length > 0) {
            boolean matched = false;
            for (String err : errors) {
                for (String kw : keywords) {
                    if (err.contains(kw)) { matched = true; break; }
                }
                if (matched) break;
            }
            assertTrue(matched, fixture + " 拒绝原因应含关键词 " + String.join("/", keywords) + "，实际: " + errors);
        }
    }

    @Test public void bad_code_pattern() throws IOException { assertRejected("bad-code-pattern.invalid.json", "code"); }
    @Test public void bad_diagonal_v2() throws IOException { assertRejected("bad-diagonal-v2.invalid.json", "diagonal"); }
    @Test public void bad_id_pattern() throws IOException { assertRejected("bad-id-pattern.invalid.json", "id"); }
    @Test public void bad_schema_version() throws IOException { assertRejected("bad-schema-version.invalid.json", "schemaVersion"); }
    @Test public void datasource_missing_schema() throws IOException { assertRejected("datasource-missing-schema.invalid.json"); }
    @Test public void diagonal_labels_without_diagonal_v2() throws IOException { assertRejected("diagonal-labels-without-diagonal-v2.invalid.json", "diagonalLabels"); }
    @Test public void groups_missing_subtotal_v2() throws IOException { assertRejected("groups-missing-subtotal-v2.invalid.json", "subtotal", "group"); }
    @Test public void label_missing_xy() throws IOException { assertRejected("label-missing-xy.invalid.json", "x", "y"); }
    @Test public void loop_missing_each_v2() throws IOException { assertRejected("loop-missing-each-v2.invalid.json", "each"); }
    @Test public void margin_unitless_number() throws IOException { assertRejected("margin-unitless-number.invalid.json", "margin", "格式非法"); }
    @Test public void negative_length() throws IOException { assertRejected("negative-length.invalid.json"); }
    @Test public void nup_cols_overflow_v2() throws IOException { assertRejected("nup-cols-overflow-v2.invalid.json"); }
    @Test public void nup_rows_zero_v2() throws IOException { assertRejected("nup-rows-zero-v2.invalid.json"); }
    @Test public void tenant_injection() throws IOException { assertRejected("tenant-injection.invalid.json", "tenantId", "storeId"); }
    @Test public void unknown_presentation() throws IOException { assertRejected("unknown-presentation.invalid.json", "未知呈现", "presentation"); }
    @Test public void watermark_missing_text_v2() throws IOException { assertRejected("watermark-missing-text-v2.invalid.json"); }
    @Test public void watermark_opacity_range_v2() throws IOException { assertRejected("watermark-opacity-range-v2.invalid.json"); }

    @Test public void 合法_v1_0_fixture_通过校验() throws IOException {
        Path fixture = Paths.get("src/test/resources/print/fixtures/sales-note-v1.0.json");
        String json = new String(Files.readAllBytes(fixture), StandardCharsets.UTF_8);
        List<String> errors = validator.validateJson(json);
        assertTrue(errors.isEmpty(), "sales-note-v1.0 应通过校验: " + errors);
    }

    @Test public void 合法_v2_0_fixture_通过校验() throws IOException {
        for (String name : Arrays.asList("inventory-report-v2.0.json", "coupon-sheet-v2.0.json")) {
            Path fixture = Paths.get("src/test/resources/print/fixtures/" + name);
            String json = new String(Files.readAllBytes(fixture), StandardCharsets.UTF_8);
            List<String> errors = validator.validateJson(json);
            assertTrue(errors.isEmpty(), name + " 应通过校验: " + errors);
        }
    }

    @Test public void 空DSL被拒() {
        List<String> errors = validator.validateJson("");
        assertFalse(errors.isEmpty());
    }

    @Test public void 非法JSON被拒() {
        List<String> errors = validator.validateJson("{oops");
        assertFalse(errors.isEmpty());
        assertTrue(errors.get(0).contains("解析失败"));
    }

    // ---------- v1.1 label 白名单与新字段（T1 消费面⑤；schema/v1.1.json 同步） ----------

    /** label v1.1 模板构造器：body 传原始元素 JSON 片段 */
    private String labelTemplate(String elementsJson) {
        return "{\"schemaVersion\":\"1.1\",\"id\":\"tpl_v11_probe\",\"code\":\"V11_PROBE\","
                + "\"name\":\"v1.1 探针\",\"presentations\":{\"label\":{"
                + "\"size\":{\"width\":\"40mm\",\"height\":\"30mm\"},"
                + "\"body\":[" + elementsJson + "]}}}";
    }

    private List<String> validateLabelBody(String elementsJson) {
        return validator.validateJson(labelTemplate(elementsJson));
    }

    @Test public void label_v1_1_line_box_通过白名单() {
        List<String> errors = validateLabelBody(
                "{\"type\":\"text\",\"content\":\"{{name}}\",\"x\":\"2mm\",\"y\":\"2mm\",\"size\":1},"
                + "{\"type\":\"line\",\"x\":\"2mm\",\"y\":\"10mm\",\"width\":\"36mm\",\"height\":\"0mm\",\"thickness\":2},"
                + "{\"type\":\"box\",\"x\":\"1mm\",\"y\":\"1mm\",\"width\":\"38mm\",\"height\":\"28mm\",\"thickness\":2,\"radius\":\"2mm\"}");
        assertTrue(errors.isEmpty(), "line/box 应进 v1.1 白名单: " + errors);
    }

    @Test public void label_v1_1_新字段合法值通过() {
        List<String> errors = validateLabelBody(
                "{\"type\":\"text\",\"content\":\"{{name}}\",\"x\":\"2mm\",\"y\":\"2mm\",\"size\":2,\"fontRole\":\"cjk\"},"
                + "{\"type\":\"barcode\",\"content\":\"{{sku}}\",\"symbology\":\"EAN13\",\"humanReadable\":false,\"x\":\"2mm\",\"y\":\"20mm\",\"height\":\"8mm\"},"
                + "{\"type\":\"qrcode\",\"content\":\"{{sku}}\",\"size\":4,\"x\":\"30mm\",\"y\":\"20mm\"}");
        assertTrue(errors.isEmpty(), "fontRole/humanReadable/qr size 合法值应通过: " + errors);
    }

    @Test public void label_v1_0_size0_仍过校验_双读宽容口径() {
        // v1.0 存量文档 text.size=0 合法（0 折 1 归迁移器/schema 双读，后端保存闸不拒）
        List<String> errors = validateLabelBody(
                "{\"type\":\"text\",\"content\":\"{{name}}\",\"x\":\"2mm\",\"y\":\"2mm\",\"size\":0}");
        assertTrue(errors.isEmpty(), "v1.0 size:0 双读应通过: " + errors);
    }

    @Test public void label_未知类型提示文案含line_box() {
        List<String> errors = validateLabelBody(
                "{\"type\":\"table\",\"x\":\"2mm\",\"y\":\"2mm\"}");
        assertFalse(errors.isEmpty());
        assertTrue(errors.get(0).contains("line/box"), "提示文案应列全六元素: " + errors);
    }

    @Test public void label_fontRole_非法值拒() {
        List<String> errors = validateLabelBody(
                "{\"type\":\"text\",\"content\":\"{{name}}\",\"x\":\"2mm\",\"y\":\"2mm\",\"fontRole\":\"tspl\"}");
        assertFalse(errors.isEmpty());
        assertTrue(errors.stream().anyMatch(e -> e.contains("fontRole")), () -> "" + errors);
    }

    @Test public void label_humanReadable_非布尔拒() {
        List<String> errors = validateLabelBody(
                "{\"type\":\"barcode\",\"content\":\"{{sku}}\",\"symbology\":\"CODE128\",\"humanReadable\":\"yes\",\"x\":\"2mm\",\"y\":\"20mm\"}");
        assertFalse(errors.isEmpty());
        assertTrue(errors.stream().anyMatch(e -> e.contains("humanReadable")), () -> "" + errors);
    }

    @Test public void label_qr_size_越界拒() {
        List<String> errors = validateLabelBody(
                "{\"type\":\"qrcode\",\"content\":\"{{sku}}\",\"size\":15,\"x\":\"2mm\",\"y\":\"2mm\"}");
        assertFalse(errors.isEmpty());
        assertTrue(errors.stream().anyMatch(e -> e.contains("1-10")), () -> "" + errors);
    }

    @Test public void label_symbology_非一期码制拒() {
        List<String> errors = validateLabelBody(
                "{\"type\":\"barcode\",\"content\":\"{{sku}}\",\"symbology\":\"UPC\",\"x\":\"2mm\",\"y\":\"2mm\"}");
        assertFalse(errors.isEmpty());
        assertTrue(errors.stream().anyMatch(e -> e.contains("CODE128/EAN13")), () -> "" + errors);
    }

    @Test public void label_元素总数超限拒() {
        StringBuilder els = new StringBuilder();
        for (int i = 0; i < 501; i++) {
            if (i > 0) els.append(',');
            els.append("{\"type\":\"text\",\"content\":\"t\",\"x\":\"1mm\",\"y\":\"")
               .append(String.format("%.1fmm", (double) (i % 28 + 1))).append("\"}");
        }
        List<String> errors = validateLabelBody(els.toString());
        assertFalse(errors.isEmpty());
        assertTrue(errors.stream().anyMatch(e -> e.contains("元素总数")), () -> "" + errors.size());
    }

    @Test public void label_文本长度超限拒() {
        String longText = "长".repeat(501);
        List<String> errors = validateLabelBody(
                "{\"type\":\"text\",\"content\":\"" + longText + "\",\"x\":\"1mm\",\"y\":\"1mm\"}");
        assertFalse(errors.isEmpty());
        assertTrue(errors.stream().anyMatch(e -> e.contains("超上限")), () -> "" + errors);
    }

    @Test public void label_thickness_越界拒() {
        List<String> errors = validateLabelBody(
                "{\"type\":\"line\",\"x\":\"2mm\",\"y\":\"2mm\",\"width\":\"36mm\",\"height\":\"0mm\",\"thickness\":64}");
        assertFalse(errors.isEmpty());
        assertTrue(errors.stream().anyMatch(e -> e.contains("thickness")), () -> "" + errors);
    }
}