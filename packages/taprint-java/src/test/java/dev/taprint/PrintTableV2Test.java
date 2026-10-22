/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import com.alibaba.fastjson.JSON;
import dev.taprint.dsl.TemplateDsl;
import dev.taprint.core.DeviceClass;
import dev.taprint.expression.PrintExpressionEvaluator;
import dev.taprint.renderer.EvaluatedElement;
import dev.taprint.renderer.EvaluatedTemplate;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DSL 2.0 表格引擎 v2 求值层测试（A2/A3）：headerRows/groups/staticRows/subtable/
 */
class PrintTableV2Test {

    private PrintExpressionEvaluator evaluator;

    @BeforeEach
    void setUp() {
        evaluator = PrintTestFixturetures.newEvaluator();
    }

    private EvaluatedTemplate evalInventoryReport() throws Exception {
        TemplateDsl dsl = PrintTestFixturetures.loadDsl("print/fixtures/inventory-report-v2.0.json");
        return evaluator.eval(dsl, DeviceClass.DOC, PrintTestFixturetures.inventoryReportMockData());
    }

    /** body 中找第一个 table 元素 */
    private EvaluatedElement findTable(EvaluatedTemplate evaluated) {
        for (EvaluatedElement el : evaluated.getBody()) {
            if ("table".equals(el.getType())) {
                return el;
            }
        }
        throw new IllegalStateException("body 中无 table 元素");
    }

    // ---- A2: headerRows 多级表头 ----

    @Test
    @DisplayName("v2 多级表头网格求值（2 行 6+4 单元格，斜线/合并透传）")
    void test_headerGrid() throws Exception {
        EvaluatedElement table = findTable(evalInventoryReport());
        assertNotNull(table.getHeaderGrid(), "headerRows 应求值为 headerGrid");
        assertEquals(2, table.getHeaderGrid().size(), "2 行表头");
        List<EvaluatedElement.EvaluatedHeaderCell> row1 = table.getHeaderGrid().get(0);
        assertEquals(6, row1.size(), "第 1 行 6 个单元格（含合并）");
        // 首格：斜线 ltr + rowspan 2 + diagonalLabels tl=项目 br=类别
        EvaluatedElement.EvaluatedHeaderCell diagonalCell = row1.get(0);
        assertEquals("ltr", diagonalCell.getDiagonal());
        assertEquals(Integer.valueOf(2), diagonalCell.getRowspan());
        assertEquals("项目", diagonalCell.getDiagonalLabels().get("tl"));
        assertEquals("类别", diagonalCell.getDiagonalLabels().get("br"));
        // "商品" colspan 2
        assertEquals(Integer.valueOf(2), row1.get(1).getColspan());
        assertEquals("商品", row1.get(1).getText());
        // 第 2 行 4 个单元格
        assertEquals(4, table.getHeaderGrid().get(1).size());
        assertEquals("编码", table.getHeaderGrid().get(1).get(0).getText());
        // v1 兼容字段 headers 仍保留（columns 表头回退路径）
        assertEquals(8, table.getHeaders().size());
    }

    // ---- A2: groups 分组小计（组内行集作用域） ----

    @Test
    @DisplayName("v2 分组小计：组内行集聚合（食品组 bookQty=15/amount=￥150.00）")
    void test_groupsSubtotal() throws Exception {
        EvaluatedElement table = findTable(evalInventoryReport());
        assertNotNull(table.getGroupBlocks(), "groups 应求值为 groupBlocks");
        assertEquals(2, table.getGroupBlocks().size(), "2 个分组（食品/日用）");

        EvaluatedElement.EvaluatedGroupBlock food = table.getGroupBlocks().get(0);
        assertEquals("类别：食品", food.getHeaderText(), "组头表达式在组首行作用域求值");
        assertEquals(2, food.getRows().size(), "食品组 2 行明细");
        assertEquals("小计", food.getSubtotalLabel());
        List<String> values = food.getSubtotalValues();
        assertEquals(8, values.size(), "subtotal.values 与 columns 逐列对齐");
        // null 前 3 列留空（nullPrefix=3）
        assertNull(values.get(0));
        assertNull(values.get(1));
        assertNull(values.get(2));
        // 组内聚合：bookQty 10+5=15；amount ￥100+￥50=￥150.00；realQty 12+4=16；diffQty 2+(-1)=1
        assertEquals("15", values.get(3), "组内 bookQty 聚合");
        assertEquals("￥150.00", values.get(4), "组内 amount 聚合 + currency 格式化");
        assertEquals("16", values.get(5), "组内 realQty 聚合");
        assertEquals("1", values.get(6), "组内 diffQty 聚合");
        assertNull(values.get(7), "subtable 容器列留空");

        EvaluatedElement.EvaluatedGroupBlock daily = table.getGroupBlocks().get(1);
        assertEquals("类别：日用", daily.getHeaderText());
        assertEquals(1, daily.getRows().size(), "日用组 1 行明细");

        // 分组模式下主 rows 为空（明细在 groupBlocks 内）
        assertTrue(table.getRows() == null || table.getRows().isEmpty());
    }

    // ---- A2: staticRows ----

    @Test
    @DisplayName("v2 静态行区：position=after + 表达式求值 + colspan 透传")
    void test_staticRows() throws Exception {
        EvaluatedElement table = findTable(evalInventoryReport());
        assertNotNull(table.getStaticRowCells());
        assertEquals("after", table.getStaticRowCells().getPosition());
        assertEquals(1, table.getStaticRowCells().getRows().size());
        List<EvaluatedElement.EvaluatedTableCell> row = table.getStaticRowCells().getRows().get(0);
        assertEquals(3, row.size());
        assertEquals("制单：张三", row.get(0).getValue(), "value 表达式在根作用域求值");
        assertEquals(Integer.valueOf(3), row.get(0).getColspan());
        assertEquals("盘点确认：", row.get(1).getValue());
        assertEquals(Integer.valueOf(2), row.get(2).getColspan());
    }

    // ---- A2: subtable ----

    @Test
    @DisplayName("v2 子表：source 指向 detail，每主行一份子行集（行作用域嵌套）")
    void test_subtable() throws Exception {
        EvaluatedElement table = findTable(evalInventoryReport());
        assertNotNull(table.getSubtables(), "subtable 列应求值");
        assertEquals(1, table.getSubtables().size());
        EvaluatedElement.EvaluatedSubtable sub = table.getSubtables().get(0);
        assertEquals(7, sub.getColumnIndex(), "批次明细为第 8 列（下标 7）");
        assertEquals(3, sub.getColumns().size(), "子表 3 列");
        assertEquals(Arrays.asList("批号", "数量", "效期"), sub.getHeaders());
        assertEquals(3, sub.getRowSubtables().size(), "与主表 3 行同序");
        for (List<List<String>> rows : sub.getRowSubtables()) {
            assertEquals(2, rows.size(), "batches detail 2 行");
            assertEquals("B20260101", rows.get(0).get(0));
            assertEquals("6", rows.get(0).get(1));
            assertEquals("2026-06-01", rows.get(0).get(2));
        }
    }

    // ---- A2: layout ----

    @Test
    @DisplayName("v2 layout.repeatHeaderOnPageBreak 透传")
    void test_layoutRepeatHeader() throws Exception {
        EvaluatedElement table = findTable(evalInventoryReport());
        assertEquals(Boolean.TRUE, table.getRepeatHeaderOnPageBreak());
    }

    // ---- A3: conditional 展平（真/假分支） ----

    @Test
    @DisplayName("v2 conditional：diffTotal>0 取 body 分支并展平")
    void test_conditionalTrueBranch() throws Exception {
        EvaluatedTemplate evaluated = evalInventoryReport();
        String joined = joinText(evaluated.getBody());
        assertTrue(joined.contains("本次盘点存在差异"), "真分支文案应展平进 body");
        assertTrue(joined.contains("￥12.50"), "分支内表达式求值");
        assertTrue(!joined.contains("账实相符"), "假分支不应出现");
        // 展平契约：body 中不得出现容器元素
        for (EvaluatedElement el : evaluated.getBody()) {
            assertTrue(!"conditional".equals(el.getType()) && !"loop".equals(el.getType()),
                    "容器必须展平，渲染器零感知");
        }
    }

    @Test
    @DisplayName("v2 conditional：diffTotal=0 取 elseBody 分支（JS 真值规则）")
    void test_conditionalFalseBranch() throws Exception {
        TemplateDsl dsl = PrintTestFixturetures.loadDsl("print/fixtures/inventory-report-v2.0.json");
        Map<String, Object> data = PrintTestFixturetures.inventoryReportMockData();
        data.put("diffTotal", BigDecimal.ZERO);
        EvaluatedTemplate evaluated = evaluator.eval(dsl, DeviceClass.DOC, data);
        String joined = joinText(evaluated.getBody());
        assertTrue(joined.contains("本次盘点账实相符"), "diffTotal=0 → elseBody");
        assertTrue(!joined.contains("存在差异"));
    }

    // ---- A3: loop 展平 ----

    @Test
    @DisplayName("v2 loop：each=batches 逐行展平，行作用域解析")
    void test_loopFlatten() throws Exception {
        EvaluatedTemplate evaluated = evalInventoryReport();
        String joined = joinText(evaluated.getBody());
        assertTrue(joined.contains("批次 B20260101：数量 6，效期 2026-06-01"),
                "loop 行作用域字段解析 + date 过滤");
        assertTrue(joined.contains("批次 B20260102：数量 6，效期 2026-07-01"));
    }

    // ---- A3: 行作用域隔离（嵌套容器不串） ----

    @Test
    @DisplayName("行作用域隔离：loop 行字段遮蔽根数据同名字段，出栈后恢复")
    void test_rowScopeIsolation() throws Exception {
        String dslJson = "{"
                + "\"schemaVersion\":\"2.0\",\"id\":\"scope_isolation\",\"code\":\"SCOPE_TEST\","
                + "\"name\":\"作用域隔离\",\"presentations\":{\"doc\":{\"page\":{\"size\":\"A4\"},"
                + "\"body\":["
                + "{\"type\":\"text\",\"content\":\"根：{{name}}\"},"
                + "{\"type\":\"loop\",\"each\":\"items\",\"body\":["
                +   "{\"type\":\"text\",\"content\":\"行：{{name}}\"},"
                +   "{\"type\":\"loop\",\"each\":\"subs\",\"body\":["
                +     "{\"type\":\"text\",\"content\":\"孙：{{tag}}-{{name}}\"}"
                +   "]}"
                + "]},"
                + "{\"type\":\"text\",\"content\":\"根尾：{{name}}\"}"
                + "]}}}";
        TemplateDsl dsl = JSON.parseObject(dslJson, TemplateDsl.class);
        Map<String, Object> data = new HashMap<>();
        data.put("name", "ROOT");
        List<Map<String, Object>> items = new ArrayList<>();
        Map<String, Object> item1 = new HashMap<>();
        item1.put("name", "ITEM1");
        List<Map<String, Object>> subs = new ArrayList<>();
        Map<String, Object> sub1 = new HashMap<>();
        sub1.put("tag", "S1");
        // 孙层无 name → 向上穿透到行作用域 ITEM1（作用域栈语义）
        subs.add(sub1);
        item1.put("subs", subs);
        items.add(item1);
        data.put("items", items);

        EvaluatedTemplate evaluated = evaluator.eval(dsl, DeviceClass.DOC, data);
        List<String> texts = new ArrayList<>();
        for (EvaluatedElement el : evaluated.getBody()) {
            texts.add(el.getText());
        }
        assertEquals(Arrays.asList("根：ROOT", "行：ITEM1", "孙：S1-ITEM1", "根尾：ROOT"), texts,
                "行作用域压栈遮蔽、出栈恢复；嵌套 loop 内层未声明字段向上穿透一层");
    }

    // ---- A3: receipt 容器（schema 允许，展平同 doc） ----

    @Test
    @DisplayName("v2 receipt 容器展平：loop/conditional 经共享 evalElements 生效")
    void test_receiptContainersFlatten() throws Exception {
        String dslJson = "{"
                + "\"schemaVersion\":\"2.0\",\"id\":\"receipt_container\",\"code\":\"RECEIPT_LOOP\","
                + "\"name\":\"小票容器\",\"presentations\":{\"receipt\":{\"width\":\"80mm\",\"body\":["
                + "{\"type\":\"text\",\"content\":\"小票头 {{billNo}}\"},"
                + "{\"type\":\"loop\",\"each\":\"items\",\"body\":["
                +   "{\"type\":\"text\",\"content\":\"{{name}} x{{qty}}\"}"
                + "]},"
                + "{\"type\":\"conditional\",\"when\":\"{{vip}}\",\"body\":["
                +   "{\"type\":\"text\",\"content\":\"VIP 客户\"}"
                + "],\"elseBody\":[{\"type\":\"text\",\"content\":\"普通客户\"}]},"
                + "{\"type\":\"cut\",\"partial\":true}"
                + "]}}}";
        TemplateDsl dsl = JSON.parseObject(dslJson, TemplateDsl.class);
        Map<String, Object> data = new HashMap<>();
        data.put("billNo", "SN001");
        data.put("vip", true);
        List<Map<String, Object>> items = new ArrayList<>();
        Map<String, Object> i1 = new HashMap<>();
        i1.put("name", "可乐");
        i1.put("qty", 2);
        Map<String, Object> i2 = new HashMap<>();
        i2.put("name", "雪碧");
        i2.put("qty", 1);
        items.add(i1);
        items.add(i2);
        data.put("items", items);

        EvaluatedTemplate evaluated = evaluator.eval(dsl, DeviceClass.RECEIPT, data);
        List<String> texts = new ArrayList<>();
        for (EvaluatedElement el : evaluated.getBody()) {
            texts.add(el.getType() + ":" + el.getText());
        }
        assertEquals(Arrays.asList(
                "text:小票头 SN001",
                "text:可乐 x2",
                "text:雪碧 x1",
                "text:VIP 客户",
                "cut:null"), texts,
                "receipt 容器展平为普通元素（含 cut 保留），渲染器零感知");
    }

    // ---- A3: label 容器容错跳过（schema 禁止，渲染侧不展平） ----

    @Test
    @DisplayName("v2 label 容器：非法 DSL 容错跳过（C1 拒绝，渲染侧不展平）")
    void test_labelContainerSkipped() throws Exception {
        String dslJson = "{"
                + "\"schemaVersion\":\"2.0\",\"id\":\"label_container\",\"code\":\"LABEL_LOOP\","
                + "\"name\":\"标签容器\",\"presentations\":{\"label\":{"
                + "\"size\":{\"width\":\"40mm\",\"height\":\"30mm\"},\"body\":["
                + "{\"type\":\"text\",\"x\":\"1mm\",\"y\":\"1mm\",\"content\":\"固定\"},"
                + "{\"type\":\"loop\",\"each\":\"items\",\"body\":["
                +   "{\"type\":\"text\",\"x\":\"1mm\",\"y\":\"5mm\",\"content\":\"{{name}}\"}"
                + "]}"
                + "]}}}";
        TemplateDsl dsl = JSON.parseObject(dslJson, TemplateDsl.class);
        Map<String, Object> data = new HashMap<>();
        List<Map<String, Object>> items = new ArrayList<>();
        Map<String, Object> i1 = new HashMap<>();
        i1.put("name", "X");
        items.add(i1);
        data.put("items", items);

        EvaluatedTemplate evaluated = evaluator.eval(dsl, DeviceClass.LABEL, data);
        assertEquals(1, evaluated.getBody().size(), "label 容器被容错跳过，仅保留合法 text");
        assertEquals("固定", evaluated.getBody().get(0).getText());
    }

    // ---- watermark 求值（image src 表达式） ----

    @Test
    @DisplayName("v2 水印求值：text 型原样透传；image 型 src 表达式求值")
    void test_watermarkEval() throws Exception {
        EvaluatedTemplate report = evalInventoryReport();
        assertNotNull(report.getWatermark());
        assertEquals("text", report.getWatermark().getType());
        assertEquals("内部资料 严禁外传", report.getWatermark().getText());
        assertEquals(Double.valueOf(0.12), report.getWatermark().getOpacity());
        assertEquals(Double.valueOf(-30.0), report.getWatermark().getAngle());
        assertEquals(Boolean.TRUE, report.getWatermark().getTile());

        TemplateDsl coupon = PrintTestFixturetures.loadDsl("print/fixtures/coupon-sheet-v2.0.json");
        EvaluatedTemplate couponEval = evaluator.eval(coupon, DeviceClass.DOC,
                PrintTestFixturetures.couponSheetMockData());
        assertNotNull(couponEval.getWatermark());
        assertEquals("image", couponEval.getWatermark().getType());
        assertTrue(couponEval.getWatermark().getSrc().startsWith("data:image/png;base64,"),
                "image 水印 src 表达式 {{logoUrl}} 应求值为 data URI");
        assertNotNull(couponEval.getDoc().getPage().getNup(), "nup 静态规格保留在 page");
        assertEquals(Integer.valueOf(2), couponEval.getDoc().getPage().getNup().getCols());
        assertEquals(Integer.valueOf(2), couponEval.getDoc().getPage().getNup().getRows());
    }

    private String joinText(List<EvaluatedElement> elements) {
        StringBuilder sb = new StringBuilder();
        for (EvaluatedElement el : elements) {
            if (el.getText() != null) {
                sb.append(el.getText()).append('\n');
            }
        }
        return sb.toString();
    }
}
