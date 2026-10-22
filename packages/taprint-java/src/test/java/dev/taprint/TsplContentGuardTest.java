/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import dev.taprint.core.PrintKernelException;
import dev.taprint.dsl.LabelPresentation;
import dev.taprint.dsl.PageSpec;
import dev.taprint.core.PrintErrorCode;
import dev.taprint.renderer.CjkRasterizer;
import dev.taprint.renderer.EvaluatedElement;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.PrintImageLoader;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import dev.taprint.renderer.TsplRenderer;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.nio.charset.Charset;
import java.util.Collections;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TsplContentGuardTest {
    private static final Charset GBK = Charset.forName("GBK");
    private final CjkRasterizer rasterizer = new CjkRasterizer();
    private final PrintImageLoader imageLoader = new PrintImageLoader();

    @BeforeAll
    static void setup() {
        CjkRasterizer rasterizer = new CjkRasterizer();
    }

    @Test
    void chineseTextUsesStrictGbkOutput() {
        String payload = gbkPayload(element("text", "货位A-01", "3mm", "3mm"));
        assertTrue(payload.contains("货位A-01"), payload);
    }

    @Test
    void rejectsUnmappableEmojiInsteadOfReplacement() {
        PrintKernelException exception = assertThrows(PrintKernelException.class,
                () -> render(element("text", "货位😀", "3mm", "3mm")));
        assertEquals(PrintErrorCode.RENDER_FAILED.getCode(), exception.getErrorCode().getCode());
        assertTrue(exception.getMessage().contains("GBK"));
    }

    @Test
    void rejectsControlCharacterInText() {
        PrintKernelException exception = assertThrows(PrintKernelException.class,
                () -> render(element("text", "货位\rPRINT 99", "3mm", "3mm")));
        assertEquals(PrintErrorCode.RENDER_FAILED.getCode(), exception.getErrorCode().getCode());
        assertTrue(exception.getMessage().contains("control"));
    }

    @Test
    void rejectsNewlineInjectionInBarcode() {
        PrintKernelException exception = assertThrows(PrintKernelException.class,
                () -> render(element("barcode", "WL:1\r\nPRINT 99", "3mm", "12mm")));
        assertEquals(PrintErrorCode.RENDER_FAILED.getCode(), exception.getErrorCode().getCode());
    }

    @Test
    void rejectsFontNameCommandInjection() {
        EvaluatedElement text = element("text", "货位A", "3mm", "3mm");
        text.setFont("A\",0,1,1,\"INJECTED");
        PrintKernelException exception = assertThrows(PrintKernelException.class,
                () -> render(text));
        assertEquals(PrintErrorCode.RENDER_FAILED.getCode(), exception.getErrorCode().getCode());
    }

    @Test
    void rejectsNewlineInjectionInQrcode() {
        PrintKernelException exception = assertThrows(PrintKernelException.class,
                () -> render(element("qrcode", "SAFE\r\nPRINT 99", "3mm", "12mm")));
        assertEquals(PrintErrorCode.RENDER_FAILED.getCode(), exception.getErrorCode().getCode());
    }

    private EvaluatedElement element(String type, String content, String x, String y) {
        EvaluatedElement element = new EvaluatedElement();
        element.setType(type);
        element.setText(content);
        element.setX(x);
        element.setY(y);
        if ("barcode".equals(type)) {
            element.setHeight("12mm");
            element.setSymbology("CODE128");
        }
        return element;
    }

    private String gbkPayload(EvaluatedElement element) {
        return new String(render(element).getPayload(), GBK);
    }

    private RenderResult render(EvaluatedElement element) {
        TsplRenderer renderer = new TsplRenderer(imageLoader, rasterizer);
        return renderer.render(template(element), RenderContext.builder().copies(1).build());
    }

    private EvaluatedTemplate template(EvaluatedElement element) {
        EvaluatedTemplate template = new EvaluatedTemplate();
        LabelPresentation label = new LabelPresentation();
        PageSpec size = new PageSpec();
        size.setWidth("60mm");
        size.setHeight("40mm");
        label.setSize(size);
        label.setGap("2mm");
        label.setDensity(8);
        label.setSpeed(4);
        template.setLabel(label);
        template.setBody(Collections.singletonList(element));
        return template;
    }
}