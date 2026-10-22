/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import dev.taprint.core.DeviceClass;
import dev.taprint.renderer.CpclRenderer;
import dev.taprint.renderer.CjkRasterizer;
import dev.taprint.renderer.EscPosCapability;
import dev.taprint.renderer.EscPosRenderer;
import dev.taprint.renderer.EvaluatedElement;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.DeviceProfile;
import dev.taprint.renderer.GbEncoding;
import dev.taprint.renderer.PrintImageLoader;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import dev.taprint.renderer.TsplRenderer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Collections;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ADR-0009 §3 表外字符策略对拍：三协议渲染器的 GBK 类内容通道，
 * 表外码点一律以 U+FFFD（EF BF BD）占位——四语言字节级 golden 的前提。
 */
class UnmappedReplacementTest {

    private static final String MIXED = "货位😀A1";

    @Test
    @DisplayName("TSPL：表外 emoji 输出 EF BF BD，表内字符原样")
    void tsplReplacesUnmappedWithUffd() {
        TsplRenderer renderer = new TsplRenderer(new PrintImageLoader(), new CjkRasterizer());
        RenderResult result = renderer.render(labelTemplate(textElement()),
                RenderContext.builder().copies(1).build());
        assertContainsUffd(result.getPayload());
        assertFalse(new String(result.getPayload(), java.nio.charset.Charset.forName("GBK")).contains("??"));
    }

    @Test
    @DisplayName("ESC/POS：GBK 内容通道表外字符占位，不再折 '?'")
    void escPosReplacesUnmappedWithUffd() {
        EscPosRenderer renderer = new EscPosRenderer(null, new PrintImageLoader(), new CjkRasterizer());
        DeviceProfile profile = new DeviceProfile();
        profile.setEscPos(EscPosCapability.defaults());
        RenderResult result = renderer.render(receiptTemplate(textElement()),
                RenderContext.builder().copies(1).deviceProfile(profile).build());
        assertContainsUffd(result.getPayload());
    }

    @Test
    @DisplayName("CPCL：非宽表外字符走 TEXT 通道时占位（GBK 内容通道）")
    void cpclReplacesUnmappedWithUffd() {
        CpclRenderer renderer = new CpclRenderer(new CjkRasterizer(), new PrintImageLoader());
        RenderResult result = renderer.render(labelTemplate(unmappedOnlyElement()),
                RenderContext.builder().copies(1).build());
        assertContainsUffd(result.getPayload());
    }

    /** 纯表外行（无 CJK 宽字符）：CPCL 才走 TEXT 通道（CJK 行整体走 EG 位图）。 */
    private static EvaluatedElement unmappedOnlyElement() {
        EvaluatedElement el = new EvaluatedElement();
        el.setType("text");
        el.setText("ID😀42");
        el.setX("3mm");
        el.setY("3mm");
        return el;
    }

    private static void assertContainsUffd(byte[] payload) {
        assertTrue(contains(payload, GbEncoding.REPLACEMENT),
                "应包含 U+FFFD 字节 EF BF BD");
    }

    private static boolean contains(byte[] haystack, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= haystack.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return true;
        }
        return false;
    }

    private EvaluatedElement textElement() {
        EvaluatedElement el = new EvaluatedElement();
        el.setType("text");
        el.setText(MIXED);
        el.setX("3mm");
        el.setY("3mm");
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
        template.setBody(Collections.singletonList(element));
        return template;
    }

    private EvaluatedTemplate receiptTemplate(EvaluatedElement element) {
        EvaluatedTemplate template = new EvaluatedTemplate();
        template.setDeviceClass(DeviceClass.RECEIPT);
        template.setReceipt(new dev.taprint.dsl.ReceiptPresentation());
        template.setBody(Collections.singletonList(element));
        return template;
    }
}
