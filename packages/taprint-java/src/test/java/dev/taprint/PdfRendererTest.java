/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import dev.taprint.barcode.BarcodeRenderer;
import dev.taprint.dsl.DocPresentation;
import dev.taprint.dsl.DslStyle;
import dev.taprint.dsl.PageSpec;
import dev.taprint.dsl.BoxEdges;
import dev.taprint.dsl.TableColumn;
import dev.taprint.core.CommandSet;
import dev.taprint.renderer.EvaluatedElement;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.PdfRenderer;
import dev.taprint.renderer.PrintImageLoader;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PDF 渲染器测试（OpenPDF 输出结构校验）。
 */
class PdfRendererTest {
    /** PDF goldens embed the bundled CJK font; skip when it is absent. */
    static boolean fontAvailable() {
        return new dev.taprint.font.ClasspathFontProvider().available();
    }


    private PdfRenderer renderer;

    @BeforeEach
    void setUp() {
        renderer = new PdfRenderer(new BarcodeRenderer(), new PrintImageLoader());
    }

    private EvaluatedTemplate docTemplate(List<EvaluatedElement> body) {
        EvaluatedTemplate t = new EvaluatedTemplate();
        DocPresentation doc = new DocPresentation();
        PageSpec page = new PageSpec();
        page.setSize("A4");
        page.setOrientation("portrait");
        BoxEdges margin = new BoxEdges();
        margin.setTop("15mm");
        margin.setBottom("15mm");
        margin.setLeft("15mm");
        margin.setRight("15mm");
        page.setMargin(margin);
        doc.setPage(page);
        t.setDoc(doc);
        t.setHeader(new ArrayList<EvaluatedElement>());
        t.setBody(body);
        t.setFooter(new ArrayList<EvaluatedElement>());
        return t;
    }

    @Test
    @DisplayName("PDF 魔数与基本结构")
    void test_pdfMagic() {
        org.junit.jupiter.api.Assumptions.assumeTrue(fontAvailable(), "bundled CJK font absent - PDF golden tests skipped");
        EvaluatedElement text = new EvaluatedElement();
        text.setType("text");
        text.setText("销售单：SN20260806001");
        text.setAlign("center");
        DslStyle style = new DslStyle();
        style.setFontSize(18);
        style.setBold(true);
        text.setStyle(style);

        RenderResult result = renderer.render(docTemplate(Arrays.asList(text)),
                RenderContext.builder().copies(1).build());
        assertEquals(CommandSet.PDF, result.getCommandSet());
        assertEquals("application/pdf", result.getMimeType());
        byte[] payload = result.getPayload();
        assertTrue(payload.length > 800, "PDF 体积异常: " + payload.length);
        assertEquals('%', (char) payload[0]);
        assertEquals('P', (char) payload[1]);
        assertEquals('D', (char) payload[2]);
        assertEquals('F', (char) payload[3]);
    }

    @Test
    @DisplayName("PDF 表格 + kvtable + 分页")
    void test_pdfTableAndKv() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(fontAvailable(), "bundled CJK font absent - PDF golden tests skipped");
        List<EvaluatedElement> body = new ArrayList<>();

        EvaluatedElement kv = new EvaluatedElement();
        kv.setType("kvtable");
        kv.setKvColumns(2);
        List<List<String[]>> kvRows = new ArrayList<>();
        kvRows.add(Arrays.asList(new String[]{"客户", "张三"}, new String[]{"电话", "138****8888"}));
        kv.setKvRows(kvRows);
        body.add(kv);

        EvaluatedElement table = new EvaluatedElement();
        table.setType("table");
        table.setHeaders(Arrays.asList("SKU", "数量", "金额"));
        TableColumn c1 = new TableColumn();
        c1.setWidth("40%");
        TableColumn c2 = new TableColumn();
        c2.setWidth("30%");
        c2.setAlign("right");
        TableColumn c3 = new TableColumn();
        c3.setWidth("30%");
        c3.setAlign("right");
        table.setColumns(Arrays.asList(c1, c2, c3));
        List<List<String>> rows = new ArrayList<>();
        rows.add(Arrays.asList("SKU001", "2", "¥10.00"));
        table.setRows(rows);
        EvaluatedElement.EvaluatedSummary summary = new EvaluatedElement.EvaluatedSummary();
        summary.setLabel("合计");
        summary.setValue("¥10.00");
        table.setSummary(Arrays.asList(summary));
        body.add(table);

        EvaluatedElement pageBreak = new EvaluatedElement();
        pageBreak.setType("pageBreak");
        body.add(pageBreak);
        EvaluatedElement tail = new EvaluatedElement();
        tail.setType("text");
        tail.setText("第二页内容");
        body.add(tail);

        RenderResult result = renderer.render(docTemplate(body),
                RenderContext.builder().copies(1).build());
        String raw = new String(result.getPayload(), "ISO-8859-1");
        assertTrue(raw.contains("/Page"), "缺少页面对象");
        assertTrue(result.getPayload().length > 2000);
    }

    @Test
    @DisplayName("PDF 条码/二维码嵌入")
    void test_pdfCodes() {
        org.junit.jupiter.api.Assumptions.assumeTrue(fontAvailable(), "bundled CJK font absent - PDF golden tests skipped");
        List<EvaluatedElement> body = new ArrayList<>();
        EvaluatedElement barcode = new EvaluatedElement();
        barcode.setType("barcode");
        barcode.setText("SN20260806001");
        barcode.setSymbology("CODE128");
        body.add(barcode);
        EvaluatedElement qr = new EvaluatedElement();
        qr.setType("qrcode");
        qr.setText("https://example.com/n/SN20260806001");
        qr.setSize(6);
        body.add(qr);

        RenderResult result = renderer.render(docTemplate(body),
                RenderContext.builder().copies(1).build());
        assertTrue(result.getPayload().length > 1500, "位图应嵌入 PDF");
    }
}
