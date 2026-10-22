/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import com.alibaba.fastjson.JSON;
import dev.taprint.barcode.BarcodeRenderer;
import dev.taprint.barcode.QrcodeRenderer;
import dev.taprint.dsl.TemplateDsl;
import dev.taprint.core.DeviceClass;
import dev.taprint.expression.PrintExpressionEvaluator;
import dev.taprint.renderer.CjkRasterizer;
import dev.taprint.renderer.DeviceProfile;
import dev.taprint.renderer.EscPosCapability;
import dev.taprint.renderer.EscPosRenderer;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.PrintImageLoader;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.Charset;
import java.util.HashMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Epson ESC/POS 的 GS ! 只改字符尺寸，LF 走纸与字高无关（默认行距固定）——
 * 倍高行换行必须按高度倍数补 LF，否则下一行叠上来。
 */
class EscPosHeightScaleTest {

    @Test
    @DisplayName("倍高行补 2 个 LF、普通行 1 个 LF（行重叠根修）")
    void doubleHeight_emitsHeightScaleLf() throws Exception {
        String dslJson = "{\"presentations\":{\"receipt\":{\"width\":\"80mm\",\"body\":["
                + "{\"type\":\"text\",\"content\":\"BIG\",\"align\":\"center\",\"style\":{\"fontSize\":\"double\"}},"
                + "{\"type\":\"text\",\"content\":\"small\"}]}}}";
        TemplateDsl dsl = JSON.parseObject(dslJson, TemplateDsl.class);
        PrintExpressionEvaluator evaluator = PrintTestFixturetures.newEvaluator();
        EvaluatedTemplate evaluated = evaluator.eval(dsl, DeviceClass.RECEIPT, new HashMap<>());

        EscPosRenderer renderer = new EscPosRenderer(new QrcodeRenderer(new BarcodeRenderer()),
                new PrintImageLoader(), new CjkRasterizer());
        DeviceProfile profile = new DeviceProfile();
        EscPosCapability cap = EscPosCapability.defaults();
        cap.setMaxWidthCols(48);
        profile.setEscPos(cap);
        RenderResult result = renderer.render(evaluated,
                RenderContext.builder().copies(1).deviceProfile(profile).build());

        byte[] payload = result.getPayload();
        Charset gbk = Charset.forName("GBK");

        // 倍高命令（GS ! 0x11）在场
        int cmdIdx = indexOf(payload, new byte[]{0x1D, 0x21, 0x11}, 0);
        assertTrue(cmdIdx >= 0, "未找到倍高命令 GS ! 0x11");

        byte[] big = "BIG".getBytes(gbk);
        int bigIdx = indexOf(payload, big, cmdIdx);
        assertTrue(bigIdx >= 0, "未找到倍高文本");
        int bigAfter = bigIdx + big.length;
        assertEquals(0x0A, payload[bigAfter] & 0xFF, "倍高行第 1 个 LF 缺失");
        assertEquals(0x0A, payload[bigAfter + 1] & 0xFF, "倍高行第 2 个 LF 缺失（行重叠根修点）");
        assertTrue((payload[bigAfter + 2] & 0xFF) != 0x0A, "倍高行 LF 超出高度倍数（多补走纸）");

        byte[] small = "small".getBytes(gbk);
        int smallIdx = indexOf(payload, small, bigAfter);
        assertTrue(smallIdx >= 0, "未找到普通文本");
        int smallAfter = smallIdx + small.length;
        assertEquals(0x0A, payload[smallAfter] & 0xFF, "普通行应恰有 1 个 LF");
        assertEquals(0x1D, payload[smallAfter + 1] & 0xFF, "普通行 LF 后应即复位命令 GS ! 0x00");
    }

    private static int indexOf(byte[] haystack, byte[] needle, int from) {
        for (int i = Math.max(from, 0); i <= haystack.length - needle.length; i++) {
            boolean hit = true;
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) {
                return i;
            }
        }
        return -1;
    }
}
