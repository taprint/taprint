/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;

/**
 * 静态行单元格（DSL v2.0，schema definitions.tableCell）。
 *
 * <p>用于 staticRows 自由合并行（签栏/合计/说明）；
 * value 为表达式，缺省即空格占位（被上方 rowspan 覆盖的场景）。
 */
@Data
public class TableCell implements Serializable {

    private static final long serialVersionUID = 1L;

    /** 表达式文本（缺省 = 空格占位） */
    private String value;

    /** 列合并（≥1，缺省 1） */
    private Integer colspan;

    /** 行合并（≥1，缺省 1） */
    private Integer rowspan;

    private String align;
    private DslStyle style;
}
