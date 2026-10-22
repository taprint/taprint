/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;
import java.util.Map;

/**
 * 表头单元格（DSL v2.0 单元格模型，schema definitions.headerCell）。
 *
 * <p>colspan/rowspan 合并；diagonal 斜线表头：
 * ltr=左上→右下、rtl=左下→右上、both=十字双斜线；
 */
@Data
public class HeaderCell implements Serializable {

    private static final long serialVersionUID = 1L;

    /** 单元格文本（可含 {{...}} 表达式；schema required） */
    private String text;

    /** 列合并（≥1，缺省 1） */
    private Integer colspan;

    /** 行合并（≥1，缺省 1） */
    private Integer rowspan;

    /** 斜线方向：ltr / rtl / both */
    private String diagonal;

    /** 斜线四角标注：tl/tr/bl/br → 文字 */
    private Map<String, String> diagonalLabels;

    private String align;
    private DslStyle style;
}
