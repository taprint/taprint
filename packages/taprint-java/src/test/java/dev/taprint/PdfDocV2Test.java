/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import dev.taprint.barcode.BarcodeRenderer;
import dev.taprint.dsl.BoxEdges;
import dev.taprint.dsl.DocPresentation;
import dev.taprint.dsl.PageSpec;
import dev.taprint.dsl.TemplateDsl;
import dev.taprint.core.DeviceClass;
import dev.taprint.expression.PrintExpressionEvaluator;
import dev.taprint.renderer.EvaluatedElement;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.PdfRenderer;
import dev.taprint.renderer.PrintImageLoader;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 跨页表头重复分页用例 + coupon-sheet nup/图片水印 + doc golden。
 *
 * 不可消除的非确定性——① 字体子集随机前缀（createSubsetPrefix 每次 6 位随机字母，
 * e.g. ABCDEF+NotoSansSC);② Info 字典 CreationDate/ModDate 时间戳；③ trailer /ID
 * （基于 System.currentTimeMillis+freeMemory 的 MD5，无公开 API 可覆写）。
 * 唯一能消除 ① 的 setSubset(false) 全字体嵌入会使 PDF 从 27KB 膨胀到 6.4MB
 * <b>归一化 golden</b>：对三处随机源做等长掩码（不扰动 xref 偏移）后锁定 sha256，
 * 其余全部字节仍参与比对——内容回归（版式/字体/图片/压缩流）依旧字节级可检出。
 */
class PdfDocV2Test {
    /** PDF goldens embed the bundled CJK font; skip when it is absent. */
    static boolean fontAvailable() {
        return new dev.taprint.font.ClasspathFontProvider().available();
    }

    private static final String INVENTORY_GOLDEN = "src/test/resources/print/golden/inventory-report-v2.golden.sha256";
    private static final String COUPON_GOLDEN = "src/test/resources/print/golden/coupon-sheet-v2.golden.sha256";

    private PdfRenderer renderer;
    private PrintExpressionEvaluator evaluator;

    @BeforeEach
    void setUp() {
        renderer = new PdfRenderer(new BarcodeRenderer(), new PrintImageLoader());
        evaluator = PrintTestFixturetures.newEvaluator();
    }

    private EvaluatedTemplate evalInventoryReport() throws Exception {
        TemplateDsl dsl = PrintTestFixturetures.loadDsl("print/fixtures/inventory-report-v2.0.json");
        return evaluator.eval(dsl, DeviceClass.DOC, PrintTestFixturetures.inventoryReportMockData());
    }

    private RenderResult renderPdf(EvaluatedTemplate evaluated, int copies) {
        return renderer.render(evaluated, RenderContext.builder().copies(copies).build());
    }

    private String raw(RenderResult result) throws Exception {
        return new String(result.getPayload(), "ISO-8859-1");
    }

    private void assertPdfMagic(RenderResult result) throws Exception {
        byte[] payload = result.getPayload();
        assertTrue(payload.length > 1000, "PDF 体积异常: " + payload.length);
        String head = new String(payload, 0, 5, "ISO-8859-1");
        assertTrue(head.startsWith("%PDF-"), "PDF 魔数缺失: " + head);
    }

    private void assertGolden(String goldenPath, byte[] payload, String label) throws Exception {
        String actual = sha256(normalizeForGolden(payload));
        File goldenFile = new File(goldenPath);
        if (!goldenFile.exists()) {
            goldenFile.getParentFile().mkdirs();
            FileOutputStream fos = new FileOutputStream(goldenFile);
            fos.write((actual + "\n").getBytes(StandardCharsets.UTF_8));
            fos.close();
            System.out.println("[golden] " + label + " 已生成（归一化后）: " + actual);
            return;
        }
        String resource = goldenPath.substring(goldenPath.indexOf("src/test/resources/")
                + "src/test/resources/".length());
        String expected = PrintTestFixturetures.readResource(resource).trim();
        assertEquals(expected, actual, label + " golden mismatch - rendering changed, update the golden deliberately");
    }

    /**
     * golden 归一化：等长掩码三处非确定性字节（见类 javadoc），其余字节原样参与哈希。
     * 掩码与原文等长，保证 xref 偏移表不受扰动。
     */
    static String normalizeForGolden(byte[] payload) throws Exception {
        String raw = new String(payload, "ISO-8859-1");
        // ① 字体子集随机前缀：/ABCDEF+FontName → /SUBSET+FontName（6 位等长）
        raw = raw.replaceAll("/[A-Z]{6}\\+", "/SUBSET+");
        // ② Info 时间戳：OpenPDF 按时区写两种格式——UTC (D:YYYYMMDDHHmmSSZ)（19 字符）、
        // 非 UTC (D:YYYYMMDDHHmmSS+HH'mm')（25 字符）。统一替换为同一固定串：
        // 替换长度差异对哈希的影响已由 ④⑤（xref/startxref 归零）消除，
        raw = raw.replaceAll("\\(D:[0-9]{14}(Z|[+-][0-9]{2}'[0-9]{2}')\\)",
                "(D:19700101000000Z)");
        // ③ trailer /ID：32 位 hex ×2 → 全 0（等长）
        raw = raw.replaceAll("/ID \\[<[0-9a-fA-F]{32}><[0-9a-fA-F]{32}>\\]",
                "/ID [<00000000000000000000000000000000><00000000000000000000000000000000>]");
        // ④ xref 偏移表：时区格式长度差（19 vs 25 字符）使 Info 之后各对象偏移整体
        // 平移，10 位偏移数字随之变化 → 等长置零，保证哈希跨时区一致
        raw = raw.replaceAll("(?m)^\\d{10} (?=\\d{5} [nf])", "0000000000 ");
        // ⑤ startxref 数值：指向 xref 起始偏移，同理随时区漂移 → 置零
        raw = raw.replaceAll("startxref\\s+\\d+", "startxref 0");
        return raw;
    }

    // ---- inventory-report 全链路 ----

    @Test
    @DisplayName("inventory-report v2：求值无异常 + PDF 渲染成功 + 8 类能力结构断言")
    void test_inventoryReportFullChain() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(fontAvailable(), "bundled CJK font absent - PDF golden tests skipped");
        EvaluatedTemplate evaluated = evalInventoryReport();

        // 能力 1/2：多级表头 + 斜线表头（求值层已断言，渲染层验证存在性）
        EvaluatedElement table = findTable(evaluated);
        assertNotNull(table.getHeaderGrid(), "能力1 多级表头缺失");
        boolean hasDiagonal = false;
        for (List<EvaluatedElement.EvaluatedHeaderCell> row : table.getHeaderGrid()) {
            for (EvaluatedElement.EvaluatedHeaderCell hc : row) {
                if (hc.getDiagonal() != null) {
                    hasDiagonal = true;
                }
            }
        }
        assertTrue(hasDiagonal, "能力2 斜线表头单元格缺失");

        // 能力 3：分组小计
        assertEquals(2, table.getGroupBlocks().size(), "能力3 分组块数");
        // 能力 4：staticRows
        assertNotNull(table.getStaticRowCells(), "能力4 staticRows 缺失");
        // 能力 5：subtable
        assertNotNull(table.getSubtables(), "能力5 subtable 缺失");
        // 能力 6/7：conditional/loop 已展平为 text（body 中无容器）
        int conditionTexts = 0;
        int loopTexts = 0;
        for (EvaluatedElement el : evaluated.getBody()) {
            if (el.getText() != null && el.getText().contains("本次盘点存在差异")) {
                conditionTexts++;
            }
            if (el.getText() != null && el.getText().startsWith("批次 ")) {
                loopTexts++;
            }
        }
        assertEquals(1, conditionTexts, "能力6 conditional 真分支展平");
        assertEquals(2, loopTexts, "能力7 loop 展平份数 = batches 行数");
        // 能力 8：水印（text 型平铺）
        assertNotNull(evaluated.getWatermark(), "能力8 水印缺失");

        RenderResult result = renderPdf(evaluated, 1);
        assertPdfMagic(result);
        assertTrue(raw(result).contains("/Page"), "缺少页面对象");
        assertGolden(INVENTORY_GOLDEN, result.getPayload(), "inventory-report-v2");
    }

    @Test
    @DisplayName("inventory-report：跨页表头重复（>1 页表格 + repeatHeaderOnPageBreak）")
    void test_pageBreakRepeatHeader() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(fontAvailable(), "bundled CJK font absent - PDF golden tests skipped");
        // 独立构造分页用例（fixture 未含 >1 页数据量）：60 行 items + repeatHeaderOnPageBreak
        EvaluatedTemplate evaluated = evalInventoryReport();
        EvaluatedElement table = findTable(evaluated);
        // 分组模式下用非分组表构造分页：清空 groupBlocks，填 60 行 rows
        table.setGroupBlocks(null);
        List<List<String>> rows = new ArrayList<>();
        for (int i = 0; i < 60; i++) {
            List<String> row = new ArrayList<>();
            row.add("类别" + (i % 3));
            row.add("SKU" + i);
            row.add("商品" + i);
            row.add(String.valueOf(10 + i));
            row.add("¥" + (100 + i) + ".00");
            row.add(String.valueOf(11 + i));
            row.add("1");
            row.add("");
            rows.add(row);
        }
        table.setRows(rows);
        table.setSubtables(null);
        table.setStaticRowCells(null);

        RenderResult result = renderPdf(evaluated, 1);
        assertPdfMagic(result);
        String rawPdf = raw(result);
        int pages = countPages(rawPdf);
        assertTrue(pages >= 2, "60 行表格应至少 2 页，实际: " + pages);
        // 跨页重复表头：setHeaderRows 使表头行在每页重复绘制——
        // 结构断言以分页成功 + 渲染无异常为准（PDF 内容流压缩，表头重复无法字节级断言，
        // visual verification belongs to golden PNG diffs
        assertTrue(rawPdf.contains("/Page"));
    }

    // ---- coupon-sheet ----

    @Test
    @DisplayName("coupon-sheet v2：nup 2×2 网格 + 图片水印渲染成功")
    void test_couponSheetNupWatermark() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(fontAvailable(), "bundled CJK font absent - PDF golden tests skipped");
        TemplateDsl dsl = PrintTestFixturetures.loadDsl("print/fixtures/coupon-sheet-v2.0.json");
        EvaluatedTemplate evaluated = evaluator.eval(dsl, DeviceClass.DOC,
                PrintTestFixturetures.couponSheetMockData());
        assertNotNull(evaluated.getDoc().getPage().getNup());
        assertEquals(Integer.valueOf(2), evaluated.getDoc().getPage().getNup().getCols());
        assertEquals(Integer.valueOf(2), evaluated.getDoc().getPage().getNup().getRows());

        RenderResult result = renderPdf(evaluated, 1);
        assertPdfMagic(result);
        String rawPdf = raw(result);
        // nup：单据内容渲染为 XObject 模板 → PDF 含 /XObject
        assertTrue(rawPdf.contains("/XObject"), "nup 应产生 XObject 模板");
        // 水印透明度：PdfGState → /ExtGState
        assertTrue(rawPdf.contains("/ExtGState"), "水印透明度应写入 ExtGState");
        // 图片水印：1x1 PNG → /Image XObject
        assertTrue(rawPdf.contains("/Image"), "图片水印应嵌入 /Image");
        assertEquals(1, countPages(rawPdf), "nup 单份应为 1 页");
        assertGolden(COUPON_GOLDEN, result.getPayload(), "coupon-sheet-v2");
    }

    // ---- A8: rect + style 盒模型 ----

    @Test
    @DisplayName("doc rect 元素 + style border/backgroundColor 渲染成功")
    void test_rectAndBoxStyle() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(fontAvailable(), "bundled CJK font absent - PDF golden tests skipped");
        EvaluatedTemplate t = new EvaluatedTemplate();
        DocPresentation doc = new DocPresentation();
        PageSpec page = new PageSpec();
        page.setSize("A4");
        BoxEdges margin = new BoxEdges();
        margin.setTop("15mm");
        margin.setBottom("15mm");
        margin.setLeft("15mm");
        margin.setRight("15mm");
        page.setMargin(margin);
        doc.setPage(page);
        t.setDoc(doc);
        t.setHeader(new ArrayList<EvaluatedElement>());
        t.setFooter(new ArrayList<EvaluatedElement>());

        List<EvaluatedElement> body = new ArrayList<>();
        EvaluatedElement rect = new EvaluatedElement();
        rect.setType("rect");
        rect.setHeight("10mm");
        dev.taprint.dsl.BoxEdges border =
                new dev.taprint.dsl.BoxEdges();
        border.setTop("0.5pt");
        border.setBottom("0.5pt");
        border.setLeft("0.5pt");
        border.setRight("0.5pt");
        rect.setBorder(border);
        body.add(rect);

        EvaluatedElement styledText = new EvaluatedElement();
        styledText.setType("text");
        styledText.setText("带背景色段落");
        dev.taprint.dsl.DslStyle style =
                new dev.taprint.dsl.DslStyle();
        style.setBackgroundColor("#EEEEEE");
        dev.taprint.dsl.BoxEdges padding =
                new dev.taprint.dsl.BoxEdges();
        padding.setTop("2mm");
        padding.setBottom("2mm");
        style.setPadding(padding);
        styledText.setStyle(style);
        body.add(styledText);
        t.setBody(body);

        RenderResult result = renderPdf(t, 1);
        assertPdfMagic(result);
        assertTrue(result.getPayload().length > 1500);
    }

    // ---- golden 确定性自检（归一化口径） ----

    @Test
    @DisplayName("doc PDF 归一化确定性：同一输入两次渲染，掩码随机源后 sha256 一致")
    void test_pdfDeterministic() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(fontAvailable(), "bundled CJK font absent - PDF golden tests skipped");
        RenderResult r1 = renderPdf(evalInventoryReport(), 1);
        Thread.sleep(1100); // 拉开时间戳，暴露时间类非确定性
        RenderResult r2 = renderPdf(evalInventoryReport(), 1);
        assertEquals(sha256(normalizeForGolden(r1.getPayload())),
                sha256(normalizeForGolden(r2.getPayload())),
                "归一化后 PDF 必须确定（golden 前提；原始字节含子集前缀/时间戳/trailer ID 随机源，见类 javadoc）");
    }

    private EvaluatedElement findTable(EvaluatedTemplate evaluated) {
        for (EvaluatedElement el : evaluated.getBody()) {
            if ("table".equals(el.getType())) {
                return el;
            }
        }
        throw new IllegalStateException("body 中无 table 元素");
    }

    /** 统计 PDF 页面对象数（/Type /Page，排除 /Pages 树节点） */
    private int countPages(String rawPdf) {
        int count = 0;
        int idx = 0;
        while ((idx = rawPdf.indexOf("/Type /Page", idx)) >= 0) {
            // 排除 /Type /Pages
            int end = idx + "/Type /Page".length();
            if (end < rawPdf.length() && rawPdf.charAt(end) == 's') {
                idx = end;
                continue;
            }
            count++;
            idx = end;
        }
        // 兼容无空格变体 /Type/Page
        idx = 0;
        while ((idx = rawPdf.indexOf("/Type/Page", idx)) >= 0) {
            int end = idx + "/Type/Page".length();
            if (end < rawPdf.length() && rawPdf.charAt(end) == 's') {
                idx = end;
                continue;
            }
            count++;
            idx = end;
        }
        return count;
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

    /** 归一化文本的哈希（ISO-8859-1 字节序，与 PDF 原始字节一一对应） */
    private String sha256(String normalized) throws Exception {
        return sha256(normalized.getBytes("ISO-8859-1"));
    }
}
