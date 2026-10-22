/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import com.alibaba.fastjson.annotation.JSONField;
import lombok.Data;

import java.io.Serializable;
import java.util.List;
import java.util.Map;

/**
 * DSL 元素（schema flowElement/receiptElement/labelElement 的并集映射）。
 *
 * <p>类型由 {@link #type} 分派：text/image/barcode/qrcode/table/kvtable/line/rect/spacer/pageBreak/cut/cashDrawer。
 * label 呈现的元素必带 x/y（绝对坐标）；receipt/doc 为流式布局。
 *
 * <p>注意：kvtable 的 columns 为整数（每行键值对组数），table 的 columns 为对象数组，
 * DSL 同名不同形，故 columns 声明为 Object，由求值层按元素类型解释。
 */
@Data
public class DslElement implements Serializable {

    private static final long serialVersionUID = 1L;

    private String type;

    // ---- text / barcode / qrcode ----
    /** 表达式文本 */
    private String content;

    // ---- image ----
    private String src;

    // ---- barcode ----
    /** CODE128/EAN13/UPC/EAN8/CODE39/ITF */
    private String symbology;

    // ---- qrcode（1-20 模块等级）/ label text 字号等级（0-10） ----
    private Integer size;

    // ---- table ----
    /** detail 数据源名 */
    private String source;
    /** kvtable: Integer；table: List&lt;TableColumn&gt;（JSON 同名不同形） */
    private Object columns;
    private List<TableSummaryItem> summary;

    // ---- table v2.0（schema flowElement.table 专属，挂在 table 元素上） ----
    /** 多级表头：行 × headerCell（含合并/斜线）；缺省回退 columns[].header 单行表头 */
    private List<List<HeaderCell>> headerRows;
    /** 表格布局控制：repeatHeaderOnPageBreak 等 */
    private Map<String, Object> layout;
    /** 分组小计（按声明顺序嵌套分组） */
    private List<TableGroup> groups;
    /** 静态行区（中国式报表自由合并行，position before/after） */
    private StaticRows staticRows;

    // ---- loop / conditional（v2.0 容器元素；求值期展平，渲染器零感知） ----
    /** loop：行集数据源名（type=detail） */
    private String each;
    /** conditional：条件表达式（JS 真值规则） */
    private String when;
    /** 容器子元素列表（JSON 字段名 body；DslElement 基线无同名字段，无歧义） */
    @JSONField(name = "body")
    private List<DslElement> children;
    /** conditional：假值分支 */
    private List<DslElement> elseBody;

    // ---- kvtable ----
    /** 行 × 键值对 × [键, 值]，叶子为表达式 */
    private List<List<List<String>>> rows;
    private Boolean compact;

    // ---- cut / cashDrawer（receipt 特有） ----
    private Boolean partial;
    private Integer pulse;

    // ---- label text ----
    private String font;

    // ---- line ----
    private String lineStyle;

    // ---- rect（v1.0 即合法类型；v2.0 渲染落地） ----
    /** rect 元素自身边框（schema rect.border） */
    private BoxEdges border;

    // ---- 布局（elementBase + labelElement 坐标，带单位字符串） ----
    private String x;
    private String y;
    private String width;
    private String height;
    private String align;
    private DslStyle style;
    private BoxEdges margin;

    @JSONField(serialize = false, deserialize = false)
    public boolean isReceiptOnly() {
        return "cut".equals(type) || "cashDrawer".equals(type);
    }
}
