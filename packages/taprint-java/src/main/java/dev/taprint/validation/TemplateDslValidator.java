/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.validation;

import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
  * Structural DSL JSON validator (hand-written rules mirroring the JSON Schemas).
 * pom 冻结无 json-schema 库，故手写实现。
 *
 * <ul>
 *   <li>保存入口（{@code PrintTemplateServiceImpl.saveVersion}）：严格拒绝——非法 DSL 不得入库</li>
 *   <li>渲染入口（{@code PrintTemplateServiceImpl.loadDsl}）：宽松——仅 warn 日志放行，防存量脏数据阻塞打印</li>
 * </ul>
 * 调用方自行决定 {@code errors.isEmpty()} 时是抛异常还是仅记日志。
 *
 * <p>校验项（与 schema/v2.0.json definitions 对齐，v1.0 严格超集）：
 * schemaVersion 双轨 pattern、顶层 required、禁 tenantId/storeId、id/code/name pattern+长度、
 * presentations 至少一种+键白名单、元素类型白名单（doc/receipt flowElement 12 型、label 6 型——v1.1 line/box）、
 * label 元素 x/y 必填、length 单位 pattern（mm/cm/pt/px，列宽可 %）、
 * v2 专属（diagonalLabels 必须伴随 diagonal、watermark if/then、nup 1-4、loop 必含 each、
 * label 呈现拒绝 loop/conditional——labelElement 不含容器）。
 */
public class TemplateDslValidator {

    // ── schemaVersion 双轨（v1.0/v2.0 pattern 分轨）──
    private static final Pattern SCHEMA_VERSION_RE = Pattern.compile("^[12]\\.[0-9]+$");

    // ── 顶层字段 pattern/长度 ──
    private static final Pattern ID_RE = Pattern.compile("^[a-zA-Z][a-zA-Z0-9_]{0,63}$");
    private static final Pattern CODE_RE = Pattern.compile("^[A-Z][A-Z0-9_]{1,31}$");

    // ── length 单位（表格列宽额外允许 %）──
    private static final Pattern LENGTH_RE = Pattern.compile("^\\d+(\\.\\d+)?(mm|cm|pt|px)$");
    private static final Pattern COLUMN_WIDTH_RE = Pattern.compile("^\\d+(\\.\\d+)?(mm|cm|pt|px|%)$");

    // ── doc/receipt flowElement 类型白名单（12 型；receipt 另含 cut/cashDrawer，非 flowElement）──
    private static final Set<String> FLOW_ELEMENT_TYPES = new HashSet<>(Arrays.asList(
            "text", "image", "barcode", "qrcode", "table", "kvtable",
            "line", "rect", "spacer", "pageBreak", "loop", "conditional"));

    // x/y/width/height），禁 loop/conditional 容器；镜像 schema/v1.1.json labelElement）──
    private static final Set<String> LABEL_ELEMENT_TYPES = new HashSet<>(Arrays.asList(
            "text", "barcode", "qrcode", "image", "line", "box"));

    private static final Set<String> FONT_ROLE_VALUES = new HashSet<>(Arrays.asList(
            "auto", "cjk", "latin"));
    private static final Set<String> SYMBOLOGY_V11_VALUES = new HashSet<>(Arrays.asList(
            "CODE128", "EAN13"));

    // ── presentations 允许的键 ──
    private static final Set<String> PRESENTATION_KEYS = new HashSet<>(Arrays.asList(
            "doc", "receipt", "label"));

    // receipt 特有元素（receiptElement = flowElement + cut + cashDrawer，schema/v2.0.json）
    private static final Set<String> RECEIPT_EXTRA_TYPES = new HashSet<>(Arrays.asList(
            "cut", "cashDrawer"));

    /**
     * 对原始 DSL JSON 做结构校验。
     *
     * @param dslJson DSL JSON 字符串
     * @return 错误列表（空=通过）；每条形如 {@code "path: 原因"}
     */
    static final int MAX_TOTAL_ELEMENTS = 500;

    static final int MAX_TEXT_LENGTH = 500;

    public List<String> validateJson(String dslJson) {
        if (dslJson == null || dslJson.trim().isEmpty()) {
            return Collections.singletonList("DSL JSON 为空");
        }
        JSONObject root;
        try {
            root = JSON.parseObject(dslJson);
        } catch (Exception e) {
            return Collections.singletonList("DSL JSON 解析失败: " + e.getMessage());
        }
        if (root == null) {
            return Collections.singletonList("DSL JSON 解析为 null");
        }
        List<String> errors = new ArrayList<>();
        validateTopLevel(root, errors);
        validatePresentations(root, errors);
        int total = countElements(root);
        if (total > MAX_TOTAL_ELEMENTS) {
            errors.add("顶层: 元素总数 " + total + " 超上限 " + MAX_TOTAL_ELEMENTS);
        }
        return errors;
    }

    /** 递归统计元素总数（body/header/footer/loop/conditional 子树） */
    private int countElements(JSONObject root) {
        int total = 0;
        JSONObject presentations = root.getJSONObject("presentations");
        if (presentations == null) {
            return 0;
        }
        for (String key : presentations.keySet()) {
            JSONObject pres = presentations.getJSONObject(key);
            if (pres == null) {
                continue;
            }
            for (String section : Arrays.asList("header", "body", "footer")) {
                JSONArray arr = pres.getJSONArray(section);
                if (arr != null) {
                    total += countElementArray(arr);
                }
            }
        }
        return total;
    }

    private int countElementArray(JSONArray elements) {
        int total = 0;
        for (int i = 0; i < elements.size(); i++) {
            JSONObject el = elements.getJSONObject(i);
            if (el == null) {
                continue;
            }
            total++;
            for (String sub : Arrays.asList("body", "elseBody")) {
                JSONArray children = el.getJSONArray(sub);
                if (children != null) {
                    total += countElementArray(children);
                }
            }
        }
        return total;
    }

    // ── 顶层校验 ──
    private void validateTopLevel(JSONObject root, List<String> errors) {
        // 禁 tenantId/storeId（安全修正：服务端注入，DSL 不得携带）
        if (root.containsKey("tenantId")) {
            errors.add("顶层: 禁止包含 tenantId（服务端注入）");
        }
        if (root.containsKey("storeId")) {
            errors.add("顶层: 禁止包含 storeId（服务端注入）");
        }

        // schemaVersion 必填 + pattern（^1.x 或 ^2.x）
        String sv = root.getString("schemaVersion");
        if (sv == null || sv.isEmpty()) {
            errors.add("顶层: 缺少必填字段 schemaVersion");
        } else if (!SCHEMA_VERSION_RE.matcher(sv).matches()) {
            errors.add("schemaVersion: 格式非法（须为 1.x 或 2.x），实际=" + sv);
        }

        // required: id/code/name/presentations
        String id = root.getString("id");
        if (id == null || id.isEmpty()) {
            errors.add("顶层: 缺少必填字段 id");
        } else if (!ID_RE.matcher(id).matches()) {
            errors.add("id: 格式非法（须 ^[a-zA-Z][a-zA-Z0-9_]{0,63}$），实际=" + id);
        }

        String code = root.getString("code");
        if (code == null || code.isEmpty()) {
            errors.add("顶层: 缺少必填字段 code");
        } else if (!CODE_RE.matcher(code).matches()) {
            errors.add("code: 格式非法（须 ^[A-Z][A-Z0-9_]{1,31}$），实际=" + code);
        }

        String name = root.getString("name");
        if (name == null || name.isEmpty()) {
            errors.add("顶层: 缺少必填字段 name");
        } else if (name.length() > 100) {
            errors.add("name: 长度超 100，实际=" + name.length());
        }

        JSONObject presentations = root.getJSONObject("presentations");
        if (presentations == null || presentations.isEmpty()) {
            errors.add("顶层: 缺少必填字段 presentations 或 presentations 为空");
        }

        // dataSources 校验：每个源必含 name/type/schema（schema/v2.0.json dataSource required）
        JSONArray dataSources = root.getJSONArray("dataSources");
        if (dataSources != null) {
            for (int i = 0; i < dataSources.size(); i++) {
                JSONObject ds = dataSources.getJSONObject(i);
                if (ds == null) continue;
                if (ds.getJSONObject("schema") == null) {
                    errors.add("dataSources[" + i + "]: 缺少必填字段 schema");
                }
                if (ds.getString("name") == null) {
                    errors.add("dataSources[" + i + "]: 缺少必填字段 name");
                }
            }
        }
    }

    // ── presentations 校验 ──
    private void validatePresentations(JSONObject root, List<String> errors) {
        JSONObject presentations = root.getJSONObject("presentations");
        if (presentations == null) {
            return; // validateTopLevel 已报缺字段
        }
        for (String key : presentations.keySet()) {
            if (!PRESENTATION_KEYS.contains(key)) {
                errors.add("presentations: 未知呈现类型 " + key + "（仅允许 doc/receipt/label）");
                continue;
            }
            JSONObject pres = presentations.getJSONObject(key);
            if (pres == null) {
                errors.add("presentations." + key + ": 值为 null");
                continue;
            }
            switch (key) {
                case "doc":
                    validateDocPresentation(pres, errors);
                    break;
                case "receipt":
                    validateReceiptPresentation(pres, errors);
                    break;
                case "label":
                    validateLabelPresentation(pres, errors);
                    break;
            }
        }
    }

    private void validateDocPresentation(JSONObject doc, List<String> errors) {
        JSONObject page = doc.getJSONObject("page");
        if (page != null) {
            validatePage(page, errors);
        }
        validateBodySections(doc, "doc", errors);
    }

    /** page 层校验：watermark/nup/length/margin（schema/v2.0.json page 定义） */
    private void validatePage(JSONObject page, List<String> errors) {
        JSONObject watermark = page.getJSONObject("watermark");
        if (watermark != null) {
            String wType = watermark.getString("type");
            if ("text".equals(wType)) {
                if (watermark.getString("text") == null) {
                    errors.add("page.watermark: type=text 时必填 text");
                }
            } else if ("image".equals(wType)) {
                if (watermark.getString("src") == null) {
                    errors.add("page.watermark: type=image 时必填 src");
                }
            }
            Double opacity = watermark.getDouble("opacity");
            if (opacity != null && (opacity <= 0 || opacity > 1)) {
                errors.add("page.watermark.opacity: 须在 (0,1] 范围，实际=" + opacity);
            }
        }
        JSONObject nup = page.getJSONObject("nup");
        if (nup != null) {
            Integer cols = nup.getInteger("cols");
            Integer rows = nup.getInteger("rows");
            if (cols != null && (cols < 1 || cols > 4)) {
                errors.add("page.nup.cols: 须 1-4，实际=" + cols);
            }
            if (rows != null && (rows < 1 || rows > 4)) {
                errors.add("page.nup.rows: 须 1-4，实际=" + rows);
            }
        }
        // page.width/height length 校验
        validateLength(page.getString("width"), "page.width", errors, false);
        validateLength(page.getString("height"), "page.height", errors, false);
        // page.margin = marginEdges
        JSONObject margin = page.getJSONObject("margin");
        if (margin != null) {
            validateMarginEdges(margin, "page.margin", errors);
        }
    }

    private void validateReceiptPresentation(JSONObject receipt, List<String> errors) {
        JSONArray body = receipt.getJSONArray("body");
        if (body == null || body.isEmpty()) {
            errors.add("presentations.receipt: 缺少必填字段 body 或 body 为空");
            return;
        }
        validateElements(body, "presentations.receipt.body", "receipt", errors);
    }

    private void validateLabelPresentation(JSONObject label, List<String> errors) {
        JSONObject size = label.getJSONObject("size");
        if (size == null) {
            errors.add("presentations.label: 缺少必填字段 size");
        } else {
            validateLength(size.getString("width"), "presentations.label.size.width", errors, false);
            validateLength(size.getString("height"), "presentations.label.size.height", errors, false);
        }
        JSONArray body = label.getJSONArray("body");
        if (body == null || body.isEmpty()) {
            errors.add("presentations.label: 缺少必填字段 body 或 body 为空");
            return;
        }
        validateElements(body, "presentations.label.body", "label", errors);
    }

    /** doc 的 header/body/footer 三个 section 都走 flow 元素校验 */
    private void validateBodySections(JSONObject doc, String device, List<String> errors) {
        for (String section : Arrays.asList("header", "body", "footer")) {
            JSONArray arr = doc.getJSONArray(section);
            if (arr != null) {
                validateElements(arr, "presentations." + device + "." + section, "flow", errors);
            }
        }
        JSONArray body = doc.getJSONArray("body");
        if (body == null || body.isEmpty()) {
            errors.add("presentations." + device + ": 缺少必填字段 body 或 body 为空");
        }
    }

    /**
     * 校验元素数组。
     *
     * @param elements  元素 JSON 数组
     * @param basePath  JSON path 前缀（如 presentations.doc.body）
     * @param elementKind "flow"=doc/receipt 元素（12 型含容器）；"label"=label 元素（4 型，不含容器）
     */
    @SuppressWarnings("unchecked")
    private void validateElements(JSONArray elements, String basePath, String elementKind, List<String> errors) {
        for (int i = 0; i < elements.size(); i++) {
            JSONObject el = elements.getJSONObject(i);
            if (el == null) {
                errors.add(basePath + "[" + i + "]: 元素为 null");
                continue;
            }
            String type = el.getString("type");
            String elPath = basePath + "[" + i + "]";
            if (type == null) {
                errors.add(elPath + ": 缺少必填字段 type");
                continue;
            }
            Set<String> allowed;
            if ("label".equals(elementKind)) {
                allowed = LABEL_ELEMENT_TYPES;
            } else if ("receipt".equals(elementKind)) {
                allowed = new HashSet<>(FLOW_ELEMENT_TYPES);
                allowed.addAll(RECEIPT_EXTRA_TYPES);
            } else {
                allowed = FLOW_ELEMENT_TYPES;
            }
            if (!allowed.contains(type)) {
                errors.add(elPath + ": 未知元素类型 " + type
                        + ("label".equals(elementKind) ? "（label 仅允许 text/barcode/qrcode/image/line/box）" : ""));
                continue;
            }
            // label 呈现拒绝 loop/conditional（labelElement 不含容器，schema 已核实）
            if ("label".equals(elementKind) && ("loop".equals(type) || "conditional".equals(type))) {
                errors.add(elPath + ": label 呈现不允许 " + type + " 容器（仅 doc/receipt 允许）");
                continue;
            }
            // label 元素 x/y 必填
            if ("label".equals(elementKind)) {
                if (el.getString("x") == null) {
                    errors.add(elPath + ": label 元素缺少必填字段 x");
                }
                if (el.getString("y") == null) {
                    errors.add(elPath + ": label 元素缺少必填字段 y");
                }
            }
            if ("label".equals(elementKind)) {
                validateLabelV11Fields(el, elPath, errors);
            }
            for (String textField : Arrays.asList("content", "src", "when")) {
                String textVal = el.getString(textField);
                if (textVal != null && textVal.length() > MAX_TEXT_LENGTH) {
                    errors.add(elPath + "." + textField + ": 长度 " + textVal.length()
                            + " 超上限 " + MAX_TEXT_LENGTH);
                }
            }
            // x/y 坐标格式校验（label 必填；flow 元素存在时同样校验——负例 negative-length）
            validateLength(el.getString("x"), elPath + ".x", errors, false);
            validateLength(el.getString("y"), elPath + ".y", errors, false);
            // 元素级 width/height（label 图像/线框用）格式校验
            validateLength(el.getString("width"), elPath + ".width", errors, false);
            validateLength(el.getString("height"), elPath + ".height", errors, false);
            // loop 必含 each
            if ("loop".equals(type)) {
                if (el.getString("each") == null || el.getString("each").isEmpty()) {
                    errors.add(elPath + ".each: loop 元素缺少必填字段 each");
                }
            }
            // v2 专属结构校验
            validateV2Structures(el, elPath, errors);
            // 递归校验 loop/conditional 子元素
            if ("loop".equals(type)) {
                JSONArray loopBody = el.getJSONArray("body");
                if (loopBody != null) {
                    validateElements(loopBody, elPath + ".body", "flow", errors);
                }
            }
            if ("conditional".equals(type)) {
                JSONArray condBody = el.getJSONArray("body");
                if (condBody != null) {
                    validateElements(condBody, elPath + ".body", "flow", errors);
                }
                JSONArray elseBody = el.getJSONArray("elseBody");
                if (elseBody != null) {
                    validateElements(elseBody, elPath + ".elseBody", "flow", errors);
                }
            }
            // table 的 columns/headerRows/groups/staticRows 递归
            if ("table".equals(type)) {
                validateTable(el, elPath, errors);
            }
            // margin 校验（marginEdges：四边必须为 length）
            JSONObject margin = el.getJSONObject("margin");
            if (margin != null) {
                validateMarginEdges(margin, elPath + ".margin", errors);
            }
        }
    }

    /**
     * v1.1 label 新增字段值域校验（与 schema/v1.1.json 对齐）：
     * 宽容口径：text.size 不在此校验值域（v1.0 双读 0-10 合法，v1.1 钉 1-10 归 schema/迁移器）。
     */
    private void validateLabelV11Fields(JSONObject el, String elPath, List<String> errors) {
        String type = el.getString("type");
        if ("text".equals(type)) {
            String fontRole = el.getString("fontRole");
            if (fontRole != null && !FONT_ROLE_VALUES.contains(fontRole)) {
                errors.add(elPath + ".fontRole: 非法值 " + fontRole + "（仅允许 auto/cjk/latin）");
            }
        } else if ("barcode".equals(type)) {
            Object hr = el.get("humanReadable");
            if (hr != null && !(hr instanceof Boolean)) {
                errors.add(elPath + ".humanReadable: 须为布尔，实际类型=" + hr.getClass().getSimpleName());
            }
            String symbology = el.getString("symbology");
            if (symbology != null && !SYMBOLOGY_V11_VALUES.contains(symbology)) {
                errors.add(elPath + ".symbology: 一期仅允许 CODE128/EAN13（D5 放开走 schema 版本），实际=" + symbology);
            }
        } else if ("qrcode".equals(type)) {
            Integer size = el.getInteger("size");
            if (size != null && (size < 1 || size > 10)) {
                errors.add(elPath + ".size: 须 1-10（D4 收窄，缺省 4），实际=" + size);
            }
        } else if ("line".equals(type) || "box".equals(type)) {
            Integer thickness = el.getInteger("thickness");
            if (thickness != null && (thickness < 1 || thickness > 32)) {
                errors.add(elPath + ".thickness: 须 1-32（dot），实际=" + thickness);
            }
        }
    }

    /** v2 专属结构：diagonalLabels 必须伴随 diagonal；watermark/nup 在 page 层；subtable/headerRows 在 table 层 */
    private void validateV2Structures(JSONObject el, String elPath, List<String> errors) {
        // diagonalLabels 必须伴随 diagonal（headerCell 场景，在 table 内校验；元素层无 headerCell）
        // watermark/nup 在 page 层（不在元素层），由 validateDocPresentation 的 page 子对象校验
    }

    /** table 元素校验：columns/headerRows/groups/staticRows/subtable */
    @SuppressWarnings("unchecked")
    private void validateTable(JSONObject table, String basePath, List<String> errors) {
        String source = table.getString("source");
        // source 可空（staticRows only 场景），非空时不在此校验引用（需 dataSources 上下文，留给 ValidateBusiness 等价层）

        JSONArray columns = table.getJSONArray("columns");
        JSONArray headerRows = table.getJSONArray("headerRows");
        if (columns == null && headerRows == null) {
            errors.add(basePath + ": table 至少需要 columns 或 headerRows 之一");
        }

        // headerRows：diagonalLabels 必须伴随 diagonal
        if (headerRows != null) {
            for (int r = 0; r < headerRows.size(); r++) {
                JSONArray row = headerRows.getJSONArray(r);
                if (row == null) {
                    continue;
                }
                for (int c = 0; c < row.size(); c++) {
                    JSONObject cell = row.getJSONObject(c);
                    if (cell == null) {
                        continue;
                    }
                    String cellPath = basePath + ".headerRows[" + r + "][" + c + "]";
                    String diagonal = cell.getString("diagonal");
                    boolean hasLabels = cell.getJSONObject("diagonalLabels") != null;
                    if (hasLabels && (diagonal == null || diagonal.isEmpty())) {
                        errors.add(cellPath + ": diagonalLabels 必须伴随 diagonal（v2.0 if/then 耦合）");
                    }
                    if (diagonal != null && !diagonal.isEmpty()) {
                        if (!Arrays.asList("ltr", "rtl", "both").contains(diagonal)) {
                            errors.add(cellPath + ".diagonal: 非法值 " + diagonal + "（仅允许 ltr/rtl/both）");
                        }
                    }
                }
            }
        }

        // groups：subtotal 必填
        JSONArray groups = table.getJSONArray("groups");
        if (groups != null) {
            for (int gi = 0; gi < groups.size(); gi++) {
                JSONObject g = groups.getJSONObject(gi);
                if (g == null) {
                    continue;
                }
                String gPath = basePath + ".groups[" + gi + "]";
                if (g.getString("field") == null) {
                    errors.add(gPath + ".field: 分组缺少必填字段 field");
                }
                JSONObject subtotal = g.getJSONObject("subtotal");
                if (subtotal == null) {
                    errors.add(gPath + ".subtotal: 分组缺少必填字段 subtotal");
                }
            }
        }

        // columns.subtable 递归
        if (columns != null) {
            for (int ci = 0; ci < columns.size(); ci++) {
                JSONObject col = columns.getJSONObject(ci);
                if (col == null) {
                    continue;
                }
                JSONObject subtable = col.getJSONObject("subtable");
                if (subtable != null) {
                    JSONArray subCols = subtable.getJSONArray("columns");
                    if (subCols == null || subCols.isEmpty()) {
                        errors.add(basePath + ".columns[" + ci + "].subtable.columns: 缺少必填字段或为空");
                    }
                }
                // 列宽校验
                String width = col.getString("width");
                if (width != null && !COLUMN_WIDTH_RE.matcher(width).matches()) {
                    errors.add(basePath + ".columns[" + ci + "].width: 格式非法（须 mm/cm/pt/px/%），实际=" + width);
                }
            }
        }

        // staticRows
        JSONObject staticRows = table.getJSONObject("staticRows");
        if (staticRows != null) {
            JSONArray rows = staticRows.getJSONArray("rows");
            if (rows == null || rows.isEmpty()) {
                errors.add(basePath + ".staticRows.rows: 缺少必填字段或为空");
            }
        }
    }

    private void validateMarginEdges(JSONObject margin, String basePath, List<String> errors) {
        for (String side : Arrays.asList("top", "right", "bottom", "left")) {
            Object val = margin.get(side);
            if (val == null) continue;
            if (!(val instanceof String)) {
                errors.add(basePath + "." + side + ": 须为 length 字符串（如 \"10mm\"），实际类型=" + val.getClass().getSimpleName());
                continue;
            }
            if (!LENGTH_RE.matcher((String) val).matches()) {
                errors.add(basePath + "." + side + ": 格式非法（须 mm/cm/pt/px），实际=" + val);
            }
        }
    }

    /** 校验 length 字段（nullable=true 时不报缺；非空时校验 pattern） */
    private void validateLength(String value, String path, List<String> errors, boolean allowPercent) {
        if (value == null || value.isEmpty()) {
            return; // nullable
        }
        Pattern re = allowPercent ? COLUMN_WIDTH_RE : LENGTH_RE;
        if (!re.matcher(value).matches()) {
            errors.add(path + ": 格式非法（须 mm/cm/pt/px" + (allowPercent ? "/%" : "") + "），实际=" + value);
        }
    }
}
