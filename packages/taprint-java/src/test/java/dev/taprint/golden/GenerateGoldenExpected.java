/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.golden;

import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

/**
 * expected 工件再生成入口（tools/fixture-codegen 的 Java 半边）。
 *
 * <p>用法：{@code java -cp <test-classpath> dev.taprint.golden.GenerateGoldenExpected
 * <fixtures-root>}——按 manifest 逐用例驱动真实渲染器，写
 * {@code expected/commands/<case>/java/frames.txt} 与（L2 用例）
 * {@code bytes.sha256}。manifest 本身由 tools/fixture-codegen 生成，本类不改它。
 */
public final class GenerateGoldenExpected {

    public static void main(String[] args) throws IOException {
        File fixturesRoot = args.length > 0
                ? new File(args[0])
                : GoldenCaseModel.fixturesRoot();
        System.out.println("[golden-codegen] fixtures root: " + fixturesRoot.getAbsolutePath());
        List<GoldenCaseModel.Case> cases = GoldenCaseModel.loadAll(fixturesRoot);
        File commandsRoot = new File(fixturesRoot, "expected/commands");
        int frames = 0;
        int digests = 0;
        for (GoldenCaseModel.Case c : cases) {
            JSONObject entry = loadManifestEntry(fixturesRoot, c.id);
            boolean l2 = GoldenCaseModel.l2Asserted(entry, "java") && !c.containsIdentityFn;
            for (GoldenDriver.Outcome outcome : GoldenDriver.run(c)) {
                File dir = new File(commandsRoot, c.id + "/java");
                if (!dir.isDirectory() && !dir.mkdirs()) {
                    throw new IOException("无法创建目录: " + dir);
                }
                Files.write(new File(dir, outcome.protocol + ".frames.txt").toPath(),
                        outcome.framesText.getBytes(StandardCharsets.UTF_8));
                frames++;
                if (l2) {
                    Files.write(new File(dir, outcome.protocol + ".bytes.sha256").toPath(),
                            (outcome.sha256 + "\n").getBytes(StandardCharsets.UTF_8));
                    digests++;
                }
            }
        }
        System.out.println("[golden-codegen] cases=" + cases.size()
                + " frames-files=" + frames + " digest-files=" + digests);
    }

    private static JSONObject loadManifestEntry(File fixturesRoot, String caseId) throws IOException {
        File manifestFile = new File(fixturesRoot, "manifest.json");
        JSONObject manifest = JSON.parseObject(
                new String(Files.readAllBytes(manifestFile.toPath()), StandardCharsets.UTF_8));
        JSONArray entries = manifest.getJSONArray("cases");
        for (int i = 0; i < entries.size(); i++) {
            JSONObject entry = entries.getJSONObject(i);
            if (caseId.equals(entry.getString("case"))) {
                return entry;
            }
        }
        throw new IllegalStateException("manifest 缺用例: " + caseId);
    }
}
