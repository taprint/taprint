/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import dev.taprint.dsl.BoxEdges;
import dev.taprint.dsl.DslStyle;
import dev.taprint.dsl.TableColumn;
import lombok.Data;

import java.util.List;
import java.util.Map;

/**
 * 求值后的元素。
 *
 * <p>表格行 rows 为求值阶段已按列 format 格式化好的字符串行；
 * kvtable 行 kvRows 为 行 × [键, 值] 已求值字符串。
 */
@Data
public class EvaluatedElement {

    private String type;

    /** text/barcode/qrcode 求值后内容；image 为求值后 src */
    private String text;

    private String align;
    private DslStyle style;
    private BoxEdges margin;

    /** 布局（原始带单位字符串，渲染器按 DPI 换算） */
    private String x;
    private String y;
    private String width;
    private String height;

    /** qrcode 模块等级 / label text 字号等级 */
    private Integer size;
    private String symbology;
    private String font;
    private String lineStyle;

    /** table */
    private List<String> headers;
    private List<TableColumn> columns;
    private List<List<String>> rows;
    private List<EvaluatedSummary> summary;

    // ---- table v2.0 求值产物（求值阶段已格式化；渲染器按存在性分派） ----

    /**
     * 多级表头网格（求值阶段已格式化）：行 × 表头单元格。
     * 缺省时为 null（回退 {@link #headers} 单行表头，v1.0 兼容）。
     * 渲染按行序 addCell，colspan/rowspan 由 OpenPDF 网格自动占位。
     */
    private List<List<EvaluatedHeaderCell>> headerGrid;

    /**
     * 分组块（求值阶段已格式化）：每组一个组头行 + 组内明细行 + 小计行。
     * 缺省时为 null（不分组，明细行平铺 {@link #rows}）。
     */
    private List<EvaluatedGroupBlock> groupBlocks;

    /** 静态行区（求值阶段已格式化）：position + 行 × 单元格 */
    private EvaluatedStaticRows staticRowCells;

    /** 明细行的子表（求值阶段已格式化）：行下标 → 该行 subtable 单元格的子行集 */
    private List<EvaluatedSubtable> subtables;

    /** 表格布局：跨页重复表头（v2.0 layout.repeatHeaderOnPageBreak） */
    private Boolean repeatHeaderOnPageBreak;

    // ---- rect v2.0 ----
    /** rect 元素自身边框（schema rect.border） */
    private BoxEdges border;

    /** kvtable */
    private Integer kvColumns;
    private Boolean compact;
    private List<List<String[]>> kvRows;

    /** cut/cashDrawer */
    private Boolean partial;
    private Integer pulse;

    @Data
    public static class EvaluatedSummary {
        private String label;
        private String value;
        private String align;
    }

    /**
     * 表头单元格求值产物（求值阶段已格式化）。
     * text 已求值；diagonalLabels 为四角位字面文字（tl/tr/bl/br）。
     */
    @Data
    public static class EvaluatedHeaderCell {
        private String text;
        private Integer colspan;
        private Integer rowspan;
        /** ltr / rtl / both */
        private String diagonal;
        private Map<String, String> diagonalLabels;
        private String align;
        private DslStyle style;
    }

    /**
     * 分组块求值产物：组头（已求值表达式文本）+ 组内明细行（同 table rows 形态）
     * + 小计行（逐列对齐，null 列留空）。
     */
    @Data
    public static class EvaluatedGroupBlock {
        /** 组头行文本（header 表达式求值结果） */
        private String headerText;
        /** 组内明细行（已按列 format 格式化） */
        private List<List<String>> rows;
        /** 小计标签（已求值） */
        private String subtotalLabel;
        /** 小计逐列值（已求值；null 元素 = 该列留空） */
        private List<String> subtotalValues;
    }

    /**
     * 静态行区求值产物（求值阶段已格式化）。
     */
    @Data
    public static class EvaluatedStaticRows {
        /** before / after（缺省 after） */
        private String position;
        /** 行 × 单元格 */
        private List<List<EvaluatedTableCell>> rows;
    }

    /**
     * 静态行单元格求值产物（value 已求值；缺省空格占位）。
     */
    @Data
    public static class EvaluatedTableCell {
        private String value;
        private Integer colspan;
        private Integer rowspan;
        private String align;
        private DslStyle style;
    }

    /**
     * 子表求值产物：挂在主表某一列（{@link #columnIndex}）下，
     * 每个主行对应一份子行集（{@link #rowSubtables} 与主表 rows 同序）。
     */
    @Data
    public static class EvaluatedSubtable {
        /** 主表列下标（容器列） */
        private int columnIndex;
        /** 子表列定义（递归同构） */
        private List<TableColumn> columns;
        /** 子表表头（已格式化） */
        private List<String> headers;
        /** 每主行的子行集（已格式化；无数据为空列表） */
        private List<List<List<String>>> rowSubtables;
    }
}
