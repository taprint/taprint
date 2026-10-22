/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;
import java.util.List;

/**
 * 分组小计（DSL v2.0，schema definitions.tableGroup）。
 *
 * <p>按 {@link #field} 值分组渲染；组头 {@link #header} 表达式在组首行作用域求值；
 * {@link Subtotal#values} 与表格 columns 逐列对齐（null = 该列留空），
 * 聚合表达式（如 {{items | sum:'amount'}}）在<b>组内行集</b>作用域求值。
 */
@Data
public class TableGroup implements Serializable {

    private static final long serialVersionUID = 1L;

    /** 分组字段（行内字段路径，必填） */
    private String field;

    /** 组头表达式（如 "类别：{{category}}"），组首行作用域求值 */
    private String header;

    /** 小计行定义（schema required） */
    private Subtotal subtotal;

    /**
     * 小计行（label + 逐列 values）。
     */
    @Data
    public static class Subtotal implements Serializable {

        private static final long serialVersionUID = 1L;

        /** 小计标签表达式（如 "小计"） */
        private String label;

        /** 与 columns 逐列对齐的表达式列表；null 元素 = 该列留空 */
        private List<String> values;
    }
}
