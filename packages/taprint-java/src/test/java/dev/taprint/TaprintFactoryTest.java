/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import com.alibaba.fastjson.JSON;
import dev.taprint.core.CommandSet;
import dev.taprint.core.DeviceClass;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Factory smoke test: assemble the kernel via {@link Taprint} with default
 * wiring and render a receipt end to end through the renderer registry.
 */
class TaprintFactoryTest {

    @Test
    @DisplayName("standard() factory renders a receipt to ESC/POS bytes")
    void test_standardFactoryEscPos() {
        String dslJson = "{\"presentations\":{\"receipt\":{\"width\":\"80mm\",\"body\":["
                + "{\"type\":\"text\",\"content\":\"{{billNo}}\",\"align\":\"center\"},"
                + "{\"type\":\"table\",\"source\":\"items\",\"columns\":["
                + "{\"header\":\"item\",\"field\":\"name\"},"
                + "{\"header\":\"qty\",\"field\":\"qty\"}]},"
                + "{\"type\":\"cut\"}]}}}";
        dev.taprint.dsl.TemplateDsl dsl = JSON.parseObject(dslJson, dev.taprint.dsl.TemplateDsl.class);
        Map<String, Object> data = new HashMap<>();
        data.put("billNo", "SN-1");
        data.put("items", java.util.List.of(
                new HashMap<String, Object>(Map.of("name", "apple", "qty", 2))));

        Taprint taprint = Taprint.standard();
        dev.taprint.renderer.EvaluatedTemplate evaluated =
                taprint.evaluator().eval(dsl, DeviceClass.RECEIPT, data);
        RenderResult result = taprint.renderers().get(CommandSet.ESC_POS)
                .render(evaluated, RenderContext.builder().copies(1).build());

        assertEquals(CommandSet.ESC_POS, result.getCommandSet());
        assertTrue(result.getPayloadSize() > 0);
        String text = new String(result.getPayload(), StandardCharsets.UTF_8);
        assertTrue(text.contains("SN-1") || new String(result.getPayload(),
                java.nio.charset.Charset.forName("GBK")).contains("SN-1"));
        assertTrue(taprint.renderers().registeredCommandSets()
                .containsAll(java.util.List.of(CommandSet.PDF, CommandSet.ESC_POS,
                        CommandSet.TSPL, CommandSet.CPCL)));
    }
}
