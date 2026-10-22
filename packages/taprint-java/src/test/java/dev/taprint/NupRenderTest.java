/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import dev.taprint.barcode.BarcodeRenderer;
import dev.taprint.dsl.DocPresentation;
import dev.taprint.dsl.DslElement;
import dev.taprint.dsl.Nup;
import dev.taprint.dsl.PageSpec;
import dev.taprint.dsl.Presentations;
import dev.taprint.dsl.TemplateDsl;
import dev.taprint.core.DeviceClass;
import dev.taprint.expression.PrintExpressionEvaluator;
import dev.taprint.renderer.EvaluatedElement;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.PdfRenderer;
import dev.taprint.renderer.PrintImageLoader;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * XObject 恒为空——修复为直接 go() 真实渲染 + status 溢出判断）。
 */
class NupRenderTest {
    /** PDF goldens embed the bundled CJK font; skip when it is absent. */
    static boolean fontAvailable() {
        return new dev.taprint.font.ClasspathFontProvider().available();
    }

    @Test
    @DisplayName("nup XObject 必须含单据内容（防 go(true) 状态消耗回归）")
    void nupXObjectHasContent() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(fontAvailable(), "bundled CJK font absent - PDF golden tests skipped");
        TemplateDsl dsl = new TemplateDsl();
        dsl.setSchemaVersion("2.0");
        dsl.setId("tpl_nup_regression");
        dsl.setCode("NUP_REGRESSION");
        dsl.setName("nup regression");
        DocPresentation doc = new DocPresentation();
        PageSpec page = new PageSpec();
        page.setSize("A4");
        Nup nup = new Nup();
        nup.setCols(2);
        nup.setRows(2);
        page.setNup(nup);
        doc.setPage(page);
        DslElement text = new DslElement();
        text.setType("text");
        text.setContent("代金券 {{couponNo}}");
        DslElement text2 = new DslElement();
        text2.setType("text");
        text2.setContent("面值：{{faceValue}}");
        doc.setBody(Arrays.asList(text, text2));
        Presentations ps = new Presentations();
        ps.setDoc(doc);
        dsl.setPresentations(ps);

        Map<String, Object> data = new HashMap<>();
        data.put("couponNo", "CPN-REG-001");
        data.put("faceValue", 100);

        PrintExpressionEvaluator evaluator = PrintTestFixturetures.newEvaluator();
        EvaluatedTemplate evaluated = evaluator.eval(dsl, DeviceClass.DOC, data);
        assertEquals(2, evaluated.getBody().size());
        assertEquals("代金券 CPN-REG-001", evaluated.getBody().get(0).getText());

        PdfRenderer renderer = new PdfRenderer(new BarcodeRenderer(), new PrintImageLoader());
        RenderResult result = renderer.render(evaluated, RenderContext.builder().copies(1).build());

        String raw = new String(result.getPayload(), "ISO-8859-1");
        int formIdx = raw.indexOf("/Subtype/Form");
        assertTrue(formIdx > 0, "缺少 nup Form XObject");
        int streamStart = raw.indexOf("stream", formIdx);
        int streamEnd = raw.indexOf("endstream", streamStart);
        assertTrue(streamEnd - streamStart > 20,
                "nup XObject 内容为空（" + (streamEnd - streamStart) + " bytes）——go(true) 状态消耗回归");
        // 2x2 网格：页面内容流应放置 4 次 XObject。
        // 内容流默认 FlateDecode 压缩，不能对原始字节 grep——解压后统计 " Do" 算子。
        java.util.List<String> streams = decompressedStreams(result.getPayload());
        int placements = 0;
        for (String s : streams) {
            int from = 0;
            while ((from = s.indexOf(" Do", from)) > 0) {
                placements++;
                from += 3;
            }
        }
        assertTrue(placements >= 4, "nup 网格放置次数不足: " + placements);
    }

    /** 解压 PDF 内所有 FlateDecode 流，返回可读文本（latin-1） */
    private static java.util.List<String> decompressedStreams(byte[] pdf) {
        java.util.List<String> out = new java.util.ArrayList<>();
        int idx = 0;
        while (true) {
            int s = indexOf(pdf, "stream".getBytes(java.nio.charset.StandardCharsets.ISO_8859_1), idx);
            if (s < 0) {
                break;
            }
            int start = s + 6;
            if (start < pdf.length && (pdf[start] == '\r' || pdf[start] == '\n')) {
                start++;
                if (start < pdf.length && pdf[start - 1] == '\r' && pdf[start] == '\n') {
                    start++;
                }
            }
            int e = indexOf(pdf, "endstream".getBytes(java.nio.charset.StandardCharsets.ISO_8859_1), start);
            if (e < 0) {
                break;
            }
            byte[] chunk = java.util.Arrays.copyOfRange(pdf, start, e);
            // 去掉结尾可能的换行
            int end = chunk.length;
            while (end > 0 && (chunk[end - 1] == '\r' || chunk[end - 1] == '\n')) {
                end--;
            }
            try {
                out.add(new String(inflate(chunk, end), java.nio.charset.StandardCharsets.ISO_8859_1));
            } catch (Exception ignore) {
                // 非 flate 流（图片等）跳过
            }
            idx = e + 9;
        }
        return out;
    }

    private static byte[] inflate(byte[] chunk, int len) throws Exception {
        java.util.zip.Inflater inf = new java.util.zip.Inflater();
        inf.setInput(chunk, 0, len);
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        try {
            while (!inf.finished()) {
                int n = inf.inflate(buf);
                if (n == 0 && inf.needsInput()) {
                    break;
                }
                bos.write(buf, 0, n);
            }
        } finally {
            inf.end();
        }
        return bos.toByteArray();
    }

    private static int indexOf(byte[] hay, byte[] needle, int from) {
        outer:
        for (int i = from; i <= hay.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }
}
