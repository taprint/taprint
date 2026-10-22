/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import dev.taprint.golden.GoldenCaseModel;
import dev.taprint.golden.GoldenDriver;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ADR-0010 golden 分层测试（Java runner）：
 * L1 帧序全量断言；L2 字节摘要按 manifest l2Assert.java 断言
 * （身份函数用例 containsIdentityFn=true 只跑 L1，L2 跳过）。
 *
 * <p>runner 用法（各语言对拍同一份工件）：fixtures/README.md。
 */
class GoldenCommandFixturesTest {

    private static File fixturesRoot;
    private static JSONObject manifest;
    private static List<GoldenCaseModel.Case> cases;

    @BeforeAll
    static void load() throws IOException {
        fixturesRoot = GoldenCaseModel.fixturesRoot();
        manifest = JSON.parseObject(new String(
                Files.readAllBytes(new File(fixturesRoot, "manifest.json").toPath()),
                StandardCharsets.UTF_8));
        cases = GoldenCaseModel.loadAll(fixturesRoot);
        assertTrue(cases.size() >= 20, "golden 用例集不完整: " + cases.size());
    }

    @Test
    @DisplayName("L1：全部用例帧序/帧参数与 expected/java 一致")
    void l1FramesMatchExpected() throws IOException {
        int compared = 0;
        StringBuilder missing = new StringBuilder();
        for (GoldenCaseModel.Case c : cases) {
            JSONObject entry = GoldenCaseModel.manifestEntry(manifest, c.id);
            if (!Boolean.TRUE.equals(entry.getJSONObject("layers").getBoolean("l1"))) {
                continue;
            }
            for (GoldenDriver.Outcome outcome : GoldenDriver.run(c)) {
                File expectedFile = new File(fixturesRoot,
                        "expected/commands/" + c.id + "/java/" + outcome.protocol + ".frames.txt");
                if (!expectedFile.isFile()) {
                    missing.append(c.id).append('/').append(outcome.protocol).append(' ');
                    continue;
                }
                String expected = new String(Files.readAllBytes(expectedFile.toPath()), StandardCharsets.UTF_8);
                assertEquals(expected, outcome.framesText,
                        "L1 帧分叉: " + c.id + "/" + outcome.protocol
                                + "（渲染行为变化须按 ADR-0010 重录并更新 docs/conformance.md）");
                compared++;
            }
        }
        assertEquals("", missing.toString(), "缺 expected 工件: " + missing);
        assertTrue(compared >= cases.size(), "L1 比对数异常: " + compared);
    }

    @Test
    @DisplayName("L2：manifest l2Assert.java 绿格字节摘要一致；身份函数用例跳过")
    void l2DigestsMatchExpected() throws IOException {
        int compared = 0;
        for (GoldenCaseModel.Case c : cases) {
            JSONObject entry = GoldenCaseModel.manifestEntry(manifest, c.id);
            if (!GoldenCaseModel.l2Asserted(entry, "java") || c.containsIdentityFn) {
                continue;
            }
            for (GoldenDriver.Outcome outcome : GoldenDriver.run(c)) {
                File digestFile = new File(fixturesRoot,
                        "expected/commands/" + c.id + "/java/" + outcome.protocol + ".bytes.sha256");
                assertTrue(digestFile.isFile(), "缺 L2 工件: " + digestFile);
                String expected = new String(Files.readAllBytes(digestFile.toPath()),
                        StandardCharsets.UTF_8).trim();
                assertEquals(expected, outcome.sha256,
                        "L2 字节分叉: " + c.id + "/" + outcome.protocol);
                compared++;
            }
        }
        assertTrue(compared >= 20, "L2 绿格比对数异常: " + compared);
    }

    @Test
    @DisplayName("身份函数用例：containsIdentityFn=true 只产 L1，不产 L2 工件")
    void identityFnCaseSkipsL2() throws IOException {
        GoldenCaseModel.Case identity = null;
        for (GoldenCaseModel.Case c : cases) {
            if (c.containsIdentityFn) {
                identity = c;
            }
        }
        assertTrue(identity != null, "缺身份函数强制特例用例");
        for (GoldenDriver.Outcome outcome : GoldenDriver.run(identity)) {
            File digestFile = new File(fixturesRoot,
                    "expected/commands/" + identity.id + "/java/" + outcome.protocol + ".bytes.sha256");
            assertTrue(!digestFile.isFile(),
                    "身份函数用例不得携带 L2 工件（ADR-0007/0010）: " + digestFile);
            File framesFile = new File(fixturesRoot,
                    "expected/commands/" + identity.id + "/java/" + outcome.protocol + ".frames.txt");
            assertTrue(framesFile.isFile(), "身份函数用例必须有 L1 工件: " + framesFile);
            assertNotEquals("", new String(Files.readAllBytes(framesFile.toPath()), StandardCharsets.UTF_8));
        }
    }
}
