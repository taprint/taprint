/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;
import java.util.List;

/**
 * 静态行区（DSL v2.0，schema definitions.staticRows）：中国式报表的自由合并行
 * （签栏/合计/说明）。
 *
 * <p>{@link #position} 相对数据行：before / after（schema 默认 after）。
 * rows 为 行 × tableCell 网格，单元格支持 colspan/rowspan 合并。
 */
@Data
public class StaticRows implements Serializable {

    private static final long serialVersionUID = 1L;

    /** before / after（缺省 after） */
    private String position;

    /** 行 × 单元格 网格 */
    private List<List<TableCell>> rows;
}
