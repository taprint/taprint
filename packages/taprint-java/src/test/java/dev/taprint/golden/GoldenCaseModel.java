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
import java.util.ArrayList;
import java.util.List;

/**
 * Golden 用例模型与仓库工件装载（fixtures/cases + fixtures/manifest.json）。
 *
 * <p>规范 {@code taprint/golden-case@1}：见 fixtures/README.md §工件规格。
 */
public final class GoldenCaseModel {

    public static final String CASE_SCHEMA = "taprint/golden-case@1";

    /** 用例定义（canonical 输入 + 矩阵/特例标记）。 */
    public static final class Case {
        public String id;
        public String title;
        public String profile;
        public List<String> protocols = new ArrayList<>();
        public boolean containsIdentityFn;
        public String special;
        public List<String> matrixCells = new ArrayList<>();
        public JSONObject input;
        public JSONObject raw;
    }

    /** manifest 内的用例条目。 */
    public static final class ManifestEntry {
        public String id;
        public String file;
        public String profile;
        public List<String> protocols = new ArrayList<>();
        public boolean containsIdentityFn;
        public boolean l1;
        public boolean l2;
        public JSONObject l2AssertLangs;
    }

    private GoldenCaseModel() {
    }

    /** 仓库 fixtures 根定位：系统属性优先，退回从模块目录向上找。 */
    public static File fixturesRoot() {
        String override = System.getProperty("taprint.fixtures.root");
        if (override != null && !override.isEmpty()) {
            return new File(override);
        }
        File dir = new File(System.getProperty("user.dir"));
        for (int depth = 0; depth < 6 && dir != null; depth++) {
            File candidate = new File(dir, "fixtures/manifest.json");
            if (candidate.isFile()) {
                return new File(dir, "fixtures");
            }
            dir = dir.getParentFile();
        }
        throw new IllegalStateException("fixtures 根未找到（可用 -Dtaprint.fixtures.root 指定）");
    }

    /** 装载全部用例（manifest 登记序）。 */
    public static List<Case> loadAll(File fixturesRoot) throws IOException {
        File manifestFile = new File(fixturesRoot, "manifest.json");
        JSONObject manifest = JSON.parseObject(
                new String(Files.readAllBytes(manifestFile.toPath()), StandardCharsets.UTF_8));
        List<Case> cases = new ArrayList<>();
        for (Object item : manifest.getJSONArray("cases")) {
            JSONObject entry = (JSONObject) item;
            File caseFile = new File(fixturesRoot, entry.getString("file"));
            JSONObject raw = JSON.parseObject(
                    new String(Files.readAllBytes(caseFile.toPath()), StandardCharsets.UTF_8));
            if (!CASE_SCHEMA.equals(raw.getString("schema"))) {
                throw new IllegalStateException("未知用例 schema: " + caseFile);
            }
            Case c = new Case();
            c.id = raw.getString("id");
            c.title = raw.getString("title");
            c.profile = raw.getString("profile");
            c.protocols.addAll(raw.getJSONArray("protocols").toJavaList(String.class));
            c.containsIdentityFn = Boolean.TRUE.equals(raw.getBoolean("containsIdentityFn"));
            c.special = raw.getString("special");
            JSONArray cells = raw.getJSONArray("matrixCells");
            if (cells != null) {
                for (Object cell : cells) {
                    JSONObject obj = (JSONObject) cell;
                    c.matrixCells.add(obj.getString("protocol") + ":" + obj.getString("feature"));
                }
            }
            c.input = raw.getJSONObject("input");
            c.raw = raw;
            cases.add(c);
        }
        return cases;
    }

    /** 用例 L2 是否对该语言断言（manifest l2Assert 布尔面；未列语言=否）。 */
    public static boolean l2Asserted(JSONObject manifestEntry, String lang) {
        JSONObject l2Assert = manifestEntry.getJSONObject("l2Assert");
        return l2Assert != null && Boolean.TRUE.equals(l2Assert.getBoolean(lang));
    }

    /** manifest 用例条目（按 id 索引）。 */
    public static JSONObject manifestEntry(JSONObject manifest, String caseId) {
        for (Object item : manifest.getJSONArray("cases")) {
            JSONObject entry = (JSONObject) item;
            if (caseId.equals(entry.getString("case"))) {
                return entry;
            }
        }
        throw new IllegalStateException("manifest 缺用例: " + caseId);
    }
}
