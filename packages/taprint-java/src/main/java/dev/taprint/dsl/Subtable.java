/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;
import java.util.List;

/**
 * 嵌套子表 / 主从表（DSL v2.0，schema tableColumn.subtable）。
 *
 * <p>所属列为子表容器：{@link #source} 指向 dataSources 中 type=detail 的行集时，
 * 每个主行渲染该 detail 子集；缺省取 {@code field} 指向的行内子数组。
 * columns 与顶层 tableColumn 同构（递归定义）。
 */
@Data
public class Subtable implements Serializable {

    private static final long serialVersionUID = 1L;

    /** 子行集合数据源名（dataSources[].name，type=detail）；缺省取 field 指向的行内子数组 */
    private String source;

    /** 子表列（递归 tableColumn 结构） */
    private List<TableColumn> columns;
}
