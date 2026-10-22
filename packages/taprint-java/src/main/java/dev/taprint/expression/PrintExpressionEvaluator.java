/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.expression;

import dev.taprint.core.PrintKernelException;
import dev.taprint.core.KernelOptions;
import dev.taprint.dsl.DslElement;
import dev.taprint.dsl.HeaderCell;
import dev.taprint.dsl.StaticRows;
import dev.taprint.dsl.Subtable;
import dev.taprint.dsl.TableCell;
import dev.taprint.dsl.TableColumn;
import dev.taprint.dsl.TableGroup;
import dev.taprint.dsl.TemplateDsl;
import dev.taprint.dsl.TableSummaryItem;
import dev.taprint.dsl.Watermark;
import dev.taprint.core.DeviceClass;
import dev.taprint.core.PrintErrorCode;
import dev.taprint.expression.TemplateAst.EachNode;
import dev.taprint.expression.TemplateAst.IfNode;
import dev.taprint.expression.TemplateAst.TemplateNode;
import dev.taprint.expression.TemplateAst.TextNode;
import dev.taprint.renderer.EvaluatedElement;
import dev.taprint.renderer.EvaluatedTemplate;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 输出 EvaluatedTemplate。
 *
 * <p>单表达式求值委托 {@link QLExpress4Engine}（StrategyIsolation 沙箱 + 100ms 超时）；
 * 管道语法先经 {@link PipeCompiler} 编译为函数调用；块语法（#if/#each）由自研
 * {@link TemplateParser} 承担。
 *
 * <p>Data constraint: bound scopes must be Maps (the sandbox blocks Java field
 * access on arbitrary objects).
 */
public class PrintExpressionEvaluator {

    private static final Pattern PLACEHOLDER = Pattern.compile("\\{\\{(.*?)\\}\\}", Pattern.DOTALL);

    private final QLExpress4Engine engine;
    private final FilterRegistry filters;
    private final TemplateParser templateParser;
    private final SandboxPolicy sandboxPolicy;
    private final KernelOptions properties;

    public PrintExpressionEvaluator(QLExpress4Engine engine, FilterRegistry filters,
                                    SandboxPolicy sandboxPolicy, KernelOptions properties) {
        this.engine = engine;
        this.filters = filters;
        this.templateParser = new TemplateParser(sandboxPolicy);
        this.sandboxPolicy = sandboxPolicy;
        this.properties = properties;
    }

    /**
     * @param dsl         模板 DSL
     * @param deviceClass 目标呈现
     * @param data        fetcher 输出 + parameters 合并后的根数据
     */
    public EvaluatedTemplate eval(TemplateDsl dsl, DeviceClass deviceClass, Map<String, Object> data) {
        RenderBudget budget = new RenderBudget(
                properties.getExpression().getRenderBudgetMs(),
                properties.getExpression().getEachLoopTotalLimit());
        EvaluatedTemplate result = new EvaluatedTemplate();
        result.setDeviceClass(deviceClass);
        List<Map<String, Object>> scopes = new ArrayList<>();
        scopes.add(data == null ? new HashMap<>() : data);

        switch (deviceClass) {
            case DOC:
                if (dsl.getPresentations() == null || dsl.getPresentations().getDoc() == null) {
                    throw missingPresentation("doc");
                }
                result.setDoc(dsl.getPresentations().getDoc());
                result.setHeader(evalElements(result.getDoc().getHeader(), scopes, budget));
                result.setBody(evalElements(result.getDoc().getBody(), scopes, budget));
                result.setFooter(evalElements(result.getDoc().getFooter(), scopes, budget));
                result.setWatermark(evalWatermark(result.getDoc().getPage(), scopes, budget));
                break;
            case RECEIPT:
                if (dsl.getPresentations() == null || dsl.getPresentations().getReceipt() == null) {
                    throw missingPresentation("receipt");
                }
                result.setReceipt(dsl.getPresentations().getReceipt());
                result.setBody(evalElements(result.getReceipt().getBody(), scopes, budget));
                break;
            case LABEL:
                if (dsl.getPresentations() == null || dsl.getPresentations().getLabel() == null) {
                    throw missingPresentation("label");
                }
                result.setLabel(dsl.getPresentations().getLabel());
                // label 呈现不含容器元素（schema labelElement 口径）：容器属非法 DSL，
                result.setBody(evalElements(result.getLabel().getBody(), scopes, budget, false));
                break;
            default:
                throw missingPresentation(String.valueOf(deviceClass));
        }
        return result;
    }

    /**
     * 水印求值：image 型的 src 为表达式（求值后为 data URI / http URL）；
     * text 型的 text 按 schema 为字面文字不求值。静态属性（type/opacity/angle/tile/style）原样透传。
     */
    private Watermark evalWatermark(dev.taprint.dsl.PageSpec page,
                                    List<Map<String, Object>> scopes, RenderBudget budget) {
        if (page == null || page.getWatermark() == null) {
            return null;
        }
        Watermark wm = page.getWatermark();
        if (!"image".equals(wm.getType()) || wm.getSrc() == null) {
            return wm;
        }
        Watermark evaluated = new Watermark();
        evaluated.setType(wm.getType());
        evaluated.setText(wm.getText());
        evaluated.setSrc(renderTemplateString(wm.getSrc(), scopes, budget));
        evaluated.setOpacity(wm.getOpacity());
        evaluated.setAngle(wm.getAngle());
        evaluated.setTile(wm.getTile());
        evaluated.setStyle(wm.getStyle());
        return evaluated;
    }

    private PrintKernelException missingPresentation(String name) {
        return PrintKernelException.builder()
                .errorCode(PrintErrorCode.TEMPLATE_PRESENTATION_MISSING)
                .message(name)
                .build();
    }

    private List<EvaluatedElement> evalElements(List<DslElement> elements,
                                                List<Map<String, Object>> scopes, RenderBudget budget) {
        return evalElements(elements, scopes, budget, true);
    }

    /**
     * @param flattenContainers true=loop/conditional 按展平契约展开（doc/receipt）；
     *                          false=容器元素容错跳过（label，schema 不含容器）
     */
    private List<EvaluatedElement> evalElements(List<DslElement> elements,
                                                List<Map<String, Object>> scopes, RenderBudget budget,
                                                boolean flattenContainers) {
        List<EvaluatedElement> out = new ArrayList<>();
        if (elements == null) {
            return out;
        }
        for (DslElement el : elements) {
            evalElementFlat(el, scopes, budget, out, flattenContainers);
        }
        return out;
    }

    /**
     * 单元素求值并追加到 out；loop/conditional 容器按展平契约递归展开
     * （容器本身不产生 EvaluatedElement，子元素直接拼入所在 section 列表，
     * B/C 与渲染器对容器零感知）。
     */
    private void evalElementFlat(DslElement el, List<Map<String, Object>> scopes,
                                 RenderBudget budget, List<EvaluatedElement> out,
                                 boolean flattenContainers) {
        String type = el.getType() == null ? "" : el.getType();
        if ("loop".equals(type) || "conditional".equals(type)) {
            if (!flattenContainers) {
                return;
            }
            if ("loop".equals(type)) {
                evalLoop(el, scopes, budget, out);
            } else {
                evalConditional(el, scopes, budget, out);
            }
            return;
        }
        out.add(evalElement(el, scopes, budget));
    }

    /**
     * loop 容器：each 指向行集数据源（detail），逐行压行作用域栈，
     * 子元素求值后展平进当前 section 元素列表。
     */
    private void evalLoop(DslElement el, List<Map<String, Object>> scopes,
                          RenderBudget budget, List<EvaluatedElement> out) {
        Object sourceData = resolvePathInScopes(el.getEach(), scopes);
        if (!(sourceData instanceof Collection)) {
            return;
        }
        for (Object item : (Collection<?>) sourceData) {
            budget.consumeIteration();
            Map<String, Object> rowScope = toRowScope(item);
            scopes.add(rowScope);
            try {
                if (el.getChildren() != null) {
                    for (DslElement child : el.getChildren()) {
                        evalElementFlat(child, scopes, budget, out, true);
                    }
                }
            } finally {
                scopes.remove(scopes.size() - 1);
            }
        }
    }

    /**
     * conditional 容器：when 表达式按 JS 真值规则求值，真值渲染 body，否则 elseBody；
     * 选中分支的子元素展平进当前 section 元素列表。
     *
     * 先把 when 中的 {{...}} 求值替换为字面量，再整段作为表达式求值。
     */
    private void evalConditional(DslElement el, List<Map<String, Object>> scopes,
                                 RenderBudget budget, List<EvaluatedElement> out) {
        boolean branch = evalWhen(el.getWhen(), scopes, budget);
        List<DslElement> body = branch ? el.getChildren() : el.getElseBody();
        if (body == null) {
            return;
        }
        for (DslElement child : body) {
            evalElementFlat(child, scopes, budget, out, true);
        }
    }

    /**
     * when 条件求值：先把每个 {{...}} 替换为求值字面量（数字裸值、字符串单引号字面量、
     * null/undefined→null、boolean→true/false），再整段送表达式引擎。
     *
     * EXPRESSION_EVAL_FAILED，不静默选分支。空 when 按真值处理（schema required when，
     */
    private boolean evalWhen(String when, List<Map<String, Object>> scopes, RenderBudget budget) {
        if (when == null || when.trim().isEmpty()) {
            return true;
        }
        StringBuffer sb = new StringBuffer();
        Matcher m = PLACEHOLDER.matcher(when);
        while (m.find()) {
            String expr = m.group(1).trim();
            Object value = evalExpression(expr, scopes, budget);
            m.appendReplacement(sb, Matcher.quoteReplacement(whenLiteral(value)));
        }
        m.appendTail(sb);
        Object result = evalExpression(sb.toString(), scopes, budget);
        return EcmaValue.truthy(result);
    }

    private String whenLiteral(Object value) {
        if (value == null) {
            return "null";
        }
        if (value instanceof Boolean) {
            return value.toString();
        }
        if (value instanceof Number) {
            return EcmaValue.toDisplayString(value);
        }
        String s = EcmaValue.toDisplayString(value);
        StringBuilder sb = new StringBuilder("'");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\'') {
                sb.append("\\'");
            } else if (c == '\\') {
                sb.append("\\\\");
            } else if (c == '\n') {
                sb.append("\\n");
            } else if (c == '\r') {
                sb.append("\\r");
            } else if (c == '\t') {
                sb.append("\\t");
            } else {
                sb.append(c);
            }
        }
        sb.append('\'');
        return sb.toString();
    }

    private EvaluatedElement evalElement(DslElement el, List<Map<String, Object>> scopes, RenderBudget budget) {
        EvaluatedElement out = new EvaluatedElement();
        out.setType(el.getType());
        out.setAlign(el.getAlign());
        out.setStyle(el.getStyle());
        out.setMargin(el.getMargin());
        out.setX(el.getX());
        out.setY(el.getY());
        out.setWidth(el.getWidth());
        out.setHeight(el.getHeight());
        out.setSize(el.getSize());
        out.setSymbology(el.getSymbology());
        out.setFont(el.getFont());
        out.setLineStyle(el.getLineStyle());
        out.setPartial(el.getPartial());
        out.setPulse(el.getPulse());
        out.setBorder(el.getBorder());

        String type = el.getType() == null ? "" : el.getType();
        switch (type) {
            case "text":
                out.setText(renderTemplateString(el.getContent(), scopes, budget));
                break;
            case "image":
                out.setText(renderTemplateString(el.getSrc(), scopes, budget));
                break;
            case "barcode":
            case "qrcode":
                out.setText(renderTemplateString(el.getContent(), scopes, budget));
                break;
            case "table":
                evalTable(el, out, scopes, budget);
                break;
            case "kvtable":
                evalKvTable(el, out, scopes, budget);
                break;
            default:
                // line/rect/spacer/pageBreak/cut/cashDrawer：纯布局/指令元素，无需求值
                break;
        }
        return out;
    }

    // ---- table ----

    @SuppressWarnings("unchecked")
    private void evalTable(DslElement el, EvaluatedElement out,
                           List<Map<String, Object>> scopes, RenderBudget budget) {
        List<TableColumn> cols = parseColumns(el.getColumns());
        out.setColumns(cols);
        // 表头：v2 headerRows 多级表头优先，缺省回退 columns[].header 单行表头（v1.0 兼容）
        if (el.getHeaderRows() != null && !el.getHeaderRows().isEmpty()) {
            out.setHeaderGrid(evalHeaderGrid(el.getHeaderRows(), scopes, budget));
        }
        List<String> headers = new ArrayList<>();
        for (TableColumn col : cols) {
            headers.add(renderTemplateString(col.getHeader(), scopes, budget));
        }
        out.setHeaders(headers);
        // 布局：跨页重复表头
        out.setRepeatHeaderOnPageBreak(layoutRepeatHeader(el.getLayout()));

        // 明细行：source → detail 数据源
        Object sourceData = resolvePathInScopes(el.getSource(), scopes);
        List<Map<String, Object>> items = toItemList(sourceData);

        // 子表（v2.0）：先于分组求值，rowSubtables 与 items 同序
        evalSubtables(cols, items, scopes, budget, out);

        // 分组（v2.0）：按 groups 声明顺序嵌套分组；组内行集压作用域求 subtotal 聚合
        if (el.getGroups() != null && !el.getGroups().isEmpty()) {
            out.setGroupBlocks(evalGroups(el.getGroups(), el.getSource(), cols, items, scopes, budget));
            out.setRows(new ArrayList<List<String>>());
        } else {
            out.setRows(evalDetailRows(cols, items, budget));
        }

        // 静态行区（v2.0，position before/after 由渲染器决定摆放）
        if (el.getStaticRows() != null) {
            out.setStaticRowCells(evalStaticRows(el.getStaticRows(), scopes, budget));
        }

        // 合计区（根作用域）
        if (el.getSummary() != null) {
            List<EvaluatedElement.EvaluatedSummary> summary = new ArrayList<>();
            for (TableSummaryItem s : el.getSummary()) {
                EvaluatedElement.EvaluatedSummary es = new EvaluatedElement.EvaluatedSummary();
                es.setLabel(renderTemplateString(s.getLabel(), scopes, budget));
                es.setValue(renderTemplateString(s.getValue(), scopes, budget));
                es.setAlign(s.getAlign());
                summary.add(es);
            }
            out.setSummary(summary);
        }
    }

    /** layout.repeatHeaderOnPageBreak（Map 形态，容错解析） */
    private Boolean layoutRepeatHeader(Map<String, Object> layout) {
        if (layout == null) {
            return null;
        }
        Object v = layout.get("repeatHeaderOnPageBreak");
        if (v instanceof Boolean) {
            return (Boolean) v;
        }
        if (v != null) {
            return Boolean.parseBoolean(String.valueOf(v));
        }
        return null;
    }

    /** source 数据 → 行 Map 列表（非 Collection / 空 → 空列表） */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> toItemList(Object sourceData) {
        List<Map<String, Object>> items = new ArrayList<>();
        if (sourceData instanceof Collection) {
            for (Object item : (Collection<Object>) sourceData) {
                items.add(toRowScope(item));
            }
        }
        return items;
    }

    /** 明细行求值（行作用域 = 每行压作用域栈，复用既有 scopes 机制） */
    private List<List<String>> evalDetailRows(List<TableColumn> cols, List<Map<String, Object>> items,
                                              RenderBudget budget) {
        List<List<String>> rows = new ArrayList<>();
        for (Map<String, Object> item : items) {
            budget.consumeIteration();
            rows.add(evalRowCells(cols, item));
        }
        return rows;
    }

    /** 单行逐列取值 + format 格式化（field 为行内路径；subtable 容器列留空，由子表填充） */
    private List<String> evalRowCells(List<TableColumn> cols, Map<String, Object> item) {
        List<String> row = new ArrayList<>();
        for (TableColumn col : cols) {
            if (col.getSubtable() != null) {
                row.add("");
                continue;
            }
            Object raw = resolveFieldPath(item, col.getField());
            row.add(formatCellValue(raw, col.getFormat()));
        }
        return row;
    }

    /** 多级表头网格求值（text 为表达式；diagonal/diagonalLabels/colspan/rowspan 原样透传） */
    private List<List<EvaluatedElement.EvaluatedHeaderCell>> evalHeaderGrid(
            List<List<HeaderCell>> headerRows, List<Map<String, Object>> scopes, RenderBudget budget) {
        List<List<EvaluatedElement.EvaluatedHeaderCell>> grid = new ArrayList<>();
        for (List<HeaderCell> row : headerRows) {
            List<EvaluatedElement.EvaluatedHeaderCell> evalRow = new ArrayList<>();
            if (row == null) {
                grid.add(evalRow);
                continue;
            }
            for (HeaderCell cell : row) {
                EvaluatedElement.EvaluatedHeaderCell ec = new EvaluatedElement.EvaluatedHeaderCell();
                ec.setText(cell == null ? "" : renderTemplateString(cell.getText(), scopes, budget));
                if (cell != null) {
                    ec.setColspan(cell.getColspan());
                    ec.setRowspan(cell.getRowspan());
                    ec.setDiagonal(cell.getDiagonal());
                    ec.setDiagonalLabels(cell.getDiagonalLabels());
                    ec.setAlign(cell.getAlign());
                    ec.setStyle(cell.getStyle());
                }
                evalRow.add(ec);
            }
            grid.add(evalRow);
        }
        return grid;
    }

    /**
     * 分组求值：按声明顺序嵌套分组（首个 group 分当前行集，后续 group 在每个上级组内再分）。
     * 组头 header 表达式在组首行作用域求值；subtotal.values 聚合表达式在
     * <b>组内行集</b>作用域求值——求值时把组内行 List 以 table 的 source 数据源名
     * （如 items）压入作用域栈，覆盖根数据中的全量行集，
     * 使 {@code {{items | sum:'amount'}}} 类聚合表达式恰在组内行集上求值。
     */
    private List<EvaluatedElement.EvaluatedGroupBlock> evalGroups(
            List<TableGroup> groups, String sourceName, List<TableColumn> cols,
            List<Map<String, Object>> items, List<Map<String, Object>> scopes, RenderBudget budget) {
        List<EvaluatedElement.EvaluatedGroupBlock> blocks = new ArrayList<>();
        groupRecurse(groups, 0, sourceName, cols, items, scopes, budget, blocks);
        return blocks;
    }

    private void groupRecurse(List<TableGroup> groups, int depth, String sourceName,
                              List<TableColumn> cols, List<Map<String, Object>> items,
                              List<Map<String, Object>> scopes, RenderBudget budget,
                              List<EvaluatedElement.EvaluatedGroupBlock> blocks) {
        if (depth >= groups.size()) {
            return;
        }
        TableGroup group = groups.get(depth);
        // 按 field 值分组（保持首次出现顺序）
        List<Object> keyOrder = new ArrayList<>();
        Map<String, List<Map<String, Object>>> grouped = new LinkedHashMap<>();
        for (Map<String, Object> item : items) {
            Object key = resolveFieldPath(item, group.getField());
            String keyStr = EcmaValue.toDisplayString(key);
            List<Map<String, Object>> bucket = grouped.get(keyStr);
            if (bucket == null) {
                bucket = new ArrayList<>();
                grouped.put(keyStr, bucket);
                keyOrder.add(keyStr);
            }
            bucket.add(item);
        }
        for (Object keyObj : keyOrder) {
            String keyStr = String.valueOf(keyObj);
            List<Map<String, Object>> groupItems = grouped.get(keyStr);
            EvaluatedElement.EvaluatedGroupBlock block = new EvaluatedElement.EvaluatedGroupBlock();
            // 组头：组首行作用域（header 表达式如 "类别：{{category}}" 取组首行字段）
            Map<String, Object> firstRow = groupItems.get(0);
            scopes.add(firstRow);
            try {
                block.setHeaderText(renderTemplateString(group.getHeader(), scopes, budget));
            } finally {
                scopes.remove(scopes.size() - 1);
            }
            // 嵌套分组 or 叶子组（明细行 + 小计）
            if (depth < groups.size() - 1) {
                // 嵌套：组头行后递归下级分组；本层不出明细/小计
                blocks.add(block);
                groupRecurse(groups, depth + 1, sourceName, cols, groupItems, scopes, budget, blocks);
            } else {
                block.setRows(evalDetailRows(cols, groupItems, budget));
                // 小计：组内行集作用域——以 source 名压入组内行 List，聚合表达式即对组内求值
                Map<String, Object> groupScope = new HashMap<>();
                if (sourceName != null && !sourceName.isEmpty()) {
                    groupScope.put(sourceName, groupItems);
                }
                scopes.add(groupScope);
                try {
                    if (group.getSubtotal() != null) {
                        block.setSubtotalLabel(renderTemplateString(
                                group.getSubtotal().getLabel(), scopes, budget));
                        List<String> values = new ArrayList<>();
                        if (group.getSubtotal().getValues() != null) {
                            for (String expr : group.getSubtotal().getValues()) {
                                if (expr == null) {
                                    values.add(null);
                                } else {
                                    values.add(renderTemplateString(expr, scopes, budget));
                                }
                            }
                        }
                        block.setSubtotalValues(values);
                    }
                } finally {
                    scopes.remove(scopes.size() - 1);
                }
                blocks.add(block);
            }
        }
    }

    /**
     * 子表求值：容器列的 subtable——source 指向 detail 数据源时每主行渲染该 detail 子集；
     * 缺省取 field 指向的行内子数组。子表列递归同构（不支持三级以上时列仍按一级求值）。
     */
    private void evalSubtables(List<TableColumn> cols, List<Map<String, Object>> items,
                               List<Map<String, Object>> scopes, RenderBudget budget,
                               EvaluatedElement out) {
        List<EvaluatedElement.EvaluatedSubtable> subtables = new ArrayList<>();
        for (int ci = 0; ci < cols.size(); ci++) {
            TableColumn col = cols.get(ci);
            if (col.getSubtable() == null) {
                continue;
            }
            Subtable st = col.getSubtable();
            List<TableColumn> subCols = st.getColumns() == null
                    ? new ArrayList<TableColumn>() : st.getColumns();
            EvaluatedElement.EvaluatedSubtable evalSt = new EvaluatedElement.EvaluatedSubtable();
            evalSt.setColumnIndex(ci);
            evalSt.setColumns(subCols);
            List<String> subHeaders = new ArrayList<>();
            for (TableColumn sc : subCols) {
                subHeaders.add(renderTemplateString(sc.getHeader(), scopes, budget));
            }
            evalSt.setHeaders(subHeaders);

            List<List<List<String>>> rowSubtables = new ArrayList<>();
            for (Map<String, Object> item : items) {
                budget.consumeIteration();
                List<Map<String, Object>> subItems;
                if (st.getSource() != null && !st.getSource().isEmpty()) {
                    // source 指向 detail 数据源（作用域栈解析，行作用域优先）
                    subItems = toItemList(resolvePathInScopes(st.getSource(), scopes));
                } else {
                    // 缺省：field 指向的行内子数组
                    subItems = toItemList(resolveFieldPath(item, col.getField()));
                }
                List<List<String>> subRows = new ArrayList<>();
                for (Map<String, Object> subItem : subItems) {
                    budget.consumeIteration();
                    subRows.add(evalRowCells(subCols, subItem));
                }
                rowSubtables.add(subRows);
            }
            evalSt.setRowSubtables(rowSubtables);
            subtables.add(evalSt);
        }
        if (!subtables.isEmpty()) {
            out.setSubtables(subtables);
        }
    }

    /** 静态行区求值（value 为表达式；缺省空格占位） */
    private EvaluatedElement.EvaluatedStaticRows evalStaticRows(StaticRows staticRows,
                                                                List<Map<String, Object>> scopes,
                                                                RenderBudget budget) {
        EvaluatedElement.EvaluatedStaticRows evalSr = new EvaluatedElement.EvaluatedStaticRows();
        evalSr.setPosition(staticRows.getPosition() == null ? "after" : staticRows.getPosition());
        List<List<EvaluatedElement.EvaluatedTableCell>> rows = new ArrayList<>();
        if (staticRows.getRows() != null) {
            for (List<TableCell> row : staticRows.getRows()) {
                List<EvaluatedElement.EvaluatedTableCell> evalRow = new ArrayList<>();
                if (row != null) {
                    for (TableCell cell : row) {
                        EvaluatedElement.EvaluatedTableCell ec = new EvaluatedElement.EvaluatedTableCell();
                        if (cell == null) {
                            ec.setValue(" ");
                        } else {
                            ec.setValue(cell.getValue() == null ? " "
                                    : renderTemplateString(cell.getValue(), scopes, budget));
                            ec.setColspan(cell.getColspan());
                            ec.setRowspan(cell.getRowspan());
                            ec.setAlign(cell.getAlign());
                            ec.setStyle(cell.getStyle());
                        }
                        evalRow.add(ec);
                    }
                }
                rows.add(evalRow);
            }
        }
        evalSr.setRows(rows);
        return evalSr;
    }

    @SuppressWarnings("unchecked")
    private List<TableColumn> parseColumns(Object columns) {
        List<TableColumn> cols = new ArrayList<>();
        if (columns instanceof List) {
            for (Object c : (List<Object>) columns) {
                if (c instanceof TableColumn) {
                    cols.add((TableColumn) c);
                } else if (c instanceof Map) {
                    // fastjson 类型化转换：覆盖全部列字段（含 v2 subtable 递归结构），
                    cols.add(com.alibaba.fastjson.JSON.parseObject(
                            com.alibaba.fastjson.JSON.toJSONString(c), TableColumn.class));
                }
            }
        }
        return cols;
    }

    /** 行内字段路径（支持 a.b） */
    @SuppressWarnings("unchecked")
    private Object resolveFieldPath(Object item, String field) {
        if (field == null || field.isEmpty()) {
            return null;
        }
        Object current = item;
        for (String seg : field.split("\\.")) {
            if (current instanceof Map) {
                Map<String, Object> map = (Map<String, Object>) current;
                current = map.containsKey(seg) ? map.get(seg) : null;
            } else {
                return null;
            }
            if (current == null) {
                return null;
            }
        }
        return current;
    }

    /** 列 format（如 currency:CNY / date:'YYYY-MM-DD HH:mm'）→ 过滤器应用 */
    private String formatCellValue(Object raw, String format) {
        Object value = raw;
        if (format != null && !format.trim().isEmpty()) {
            FilterSpec spec = parseFilterSpec(format);
            try {
                value = filters.apply(spec.name, value, spec.args);
            } catch (PrintKernelException e) {
                throw e;
            } catch (Exception e) {
                throw PrintKernelException.builder()
                        .errorCode(PrintErrorCode.EXPRESSION_EVAL_FAILED)
                        .message("列格式化失败: " + format)
                        .cause(e)
                        .build();
            }
        }
        return EcmaValue.toDisplayString(value);
    }

    /** 解析 "name:'a b':c" 形式（引号内冒号不切分） */
    static FilterSpec parseFilterSpec(String format) {
        String f = format.trim();
        StringBuilder nameBuf = new StringBuilder();
        int i = 0;
        while (i < f.length() && f.charAt(i) != ':') {
            nameBuf.append(f.charAt(i));
            i++;
        }
        FilterSpec spec = new FilterSpec();
        spec.name = nameBuf.toString().trim();
        spec.args = new ArrayList<>();
        while (i < f.length()) {
            if (f.charAt(i) == ':') {
                i++;
            }
            StringBuilder arg = new StringBuilder();
            if (i < f.length() && (f.charAt(i) == '\'' || f.charAt(i) == '"')) {
                char quote = f.charAt(i);
                i++;
                while (i < f.length() && f.charAt(i) != quote) {
                    arg.append(f.charAt(i));
                    i++;
                }
                i++;
            } else {
                while (i < f.length() && f.charAt(i) != ':') {
                    arg.append(f.charAt(i));
                    i++;
                }
            }
            spec.args.add(arg.toString());
        }
        return spec;
    }

    static class FilterSpec {
        String name;
        List<Object> args;
    }

    // ---- kvtable ----

    private void evalKvTable(DslElement el, EvaluatedElement out,
                             List<Map<String, Object>> scopes, RenderBudget budget) {
        Object columns = el.getColumns();
        out.setKvColumns(columns instanceof Number ? ((Number) columns).intValue() : 1);
        out.setCompact(el.getCompact());
        List<List<String[]>> kvRows = new ArrayList<>();
        if (el.getRows() != null) {
            for (List<List<String>> row : el.getRows()) {
                List<String[]> evalRow = new ArrayList<>();
                if (row != null) {
                    for (List<String> pair : row) {
                        String[] kv = new String[2];
                        if (pair != null && !pair.isEmpty()) {
                            kv[0] = renderTemplateString(pair.get(0), scopes, budget);
                            kv[1] = pair.size() > 1 ? renderTemplateString(pair.get(1), scopes, budget) : "";
                        }
                        evalRow.add(kv);
                    }
                }
                kvRows.add(evalRow);
            }
        }
        out.setKvRows(kvRows);
    }

    // ---- 模板字符串求值 ----

    /** 模板字符串（可含块语法）→ 最终文本 */
    public String renderTemplateString(String template, List<Map<String, Object>> scopes, RenderBudget budget) {
        if (template == null || template.isEmpty()) {
            return "";
        }
        if (template.indexOf("{{") < 0) {
            return template;
        }
        TemplateAst ast = templateParser.parse(template);
        StringBuilder sb = new StringBuilder();
        renderNodes(ast.getNodes(), scopes, budget, sb);
        return sb.toString();
    }

    private void renderNodes(List<TemplateNode> nodes, List<Map<String, Object>> scopes,
                             RenderBudget budget, StringBuilder sb) {
        for (TemplateNode node : nodes) {
            renderNode(node, scopes, budget, sb);
        }
    }

    @SuppressWarnings("unchecked")
    private void renderNode(TemplateNode node, List<Map<String, Object>> scopes,
                            RenderBudget budget, StringBuilder sb) {
        if (node instanceof TextNode) {
            renderTextNode((TextNode) node, scopes, budget, sb);
        } else if (node instanceof IfNode) {
            IfNode ifNode = (IfNode) node;
            Object cond = evalExpression(ifNode.getCondition(), scopes, budget);
            if (EcmaValue.truthy(cond)) {
                renderNodes(ifNode.getThenBranch(), scopes, budget, sb);
            } else if (ifNode.getElseBranch() != null) {
                renderNodes(ifNode.getElseBranch(), scopes, budget, sb);
            }
        } else if (node instanceof EachNode) {
            EachNode eachNode = (EachNode) node;
            Object source = evalExpression(eachNode.getSource(), scopes, budget);
            Collection<Object> items;
            if (source instanceof Collection) {
                items = (Collection<Object>) source;
            } else if (source instanceof Map) {
                items = new ArrayList<>(((Map<String, Object>) source).values());
            } else {
                items = new ArrayList<>();
            }
            int idx = 0;
            for (Object item : items) {
                budget.consumeIteration();
                Map<String, Object> loopScope = toRowScope(item);
                loopScope.put(eachNode.getItemName(), item);
                loopScope.put(eachNode.getIndexName(), idx++);
                scopes.add(loopScope);
                try {
                    renderNodes(eachNode.getBody(), scopes, budget, sb);
                } finally {
                    scopes.remove(scopes.size() - 1);
                }
            }
        }
    }

    private void renderTextNode(TextNode node, List<Map<String, Object>> scopes,
                                RenderBudget budget, StringBuilder sb) {
        String content = node.getContent();
        if (content.indexOf("{{") < 0) {
            sb.append(content);
            return;
        }
        Matcher m = PLACEHOLDER.matcher(content);
        int last = 0;
        while (m.find()) {
            sb.append(content, last, m.start());
            String expr = m.group(1).trim();
            Object value = evalExpression(expr, scopes, budget);
            // 字面输出（quoteReplacement 语义：$ 与 \ 不做转义处理）
            sb.append(EcmaValue.toDisplayString(value));
            last = m.end();
        }
        sb.append(content, last, content.length());
    }

    /** 单表达式求值：管道编译 → 作用域合并 → QLExpress4（100ms 超时 + 沙箱） */
    public Object evalExpression(String expr, List<Map<String, Object>> scopes, RenderBudget budget) {
        budget.checkElapsed();
        String qlCode = PipeCompiler.compile(expr);
        Map<String, Object> context = mergeScopes(scopes);
        try {
            return engine.evaluate(qlCode, context, properties.getExpression().getEvalTimeoutMs());
        } catch (PrintKernelException e) {
            throw e;
        } catch (Exception e) {
            throw PrintKernelException.builder()
                    .errorCode(PrintErrorCode.EXPRESSION_EVAL_FAILED)
                    .message(expr + " - " + e.getMessage())
                    .cause(e)
                    .build();
        }
    }

    /** 作用域栈合并为单 Map（外层→内层，内层优先）；@ 变量同步编译为合法标识符 */
    private Map<String, Object> mergeScopes(List<Map<String, Object>> scopes) {
        Map<String, Object> merged = new HashMap<>();
        for (Map<String, Object> scope : scopes) {
            if (scope == null) {
                continue;
            }
            for (Map.Entry<String, Object> e : scope.entrySet()) {
                merged.put(e.getKey(), e.getValue());
                if (e.getKey() != null && e.getKey().startsWith("@")) {
                    merged.put(PipeCompiler.sanitizeIdent(e.getKey()), e.getValue());
                }
            }
        }
        return merged;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> toRowScope(Object item) {
        Map<String, Object> scope = new HashMap<>();
        if (item instanceof Map) {
            scope.putAll((Map<String, Object>) item);
        }
        return scope;
    }

    /** 路径在作用域栈中解析（首段自内向外） */
    private Object resolvePathInScopes(String path, List<Map<String, Object>> scopes) {
        if (path == null || path.isEmpty()) {
            return null;
        }
        String[] segs = path.split("\\.");
        Object current = null;
        boolean resolved = false;
        for (int i = scopes.size() - 1; i >= 0; i--) {
            Map<String, Object> scope = scopes.get(i);
            if (scope.containsKey(segs[0])) {
                current = scope.get(segs[0]);
                resolved = true;
                break;
            }
        }
        if (!resolved) {
            return null;
        }
        for (int i = 1; i < segs.length && current != null; i++) {
            current = resolveFieldPath(current, segs[i]);
        }
        return current;
    }

    private String asString(Object v) {
        return v == null ? null : String.valueOf(v);
    }
}
