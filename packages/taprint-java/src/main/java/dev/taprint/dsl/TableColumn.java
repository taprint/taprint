/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;

/**
 * 表格列定义。
 *
 * <p>format 为过滤器表达式（不带管道符前缀），如 "currency:CNY"/"date:'YYYY-MM-DD'"，
 * 求值层按 {@code value | format} 语义应用。
 *
 * <p>v2.0 新增 {@link #subtable}：该列为子表容器（主从表/嵌套子表），
 * 详见 {@link Subtable}。
 */
@Data
public class TableColumn implements Serializable {

    private static final long serialVersionUID = 1L;

    private String header;
    private String field;
    /** 物理长度或百分比（相对表格宽度） */
    private String width;
    private String align;
    private String format;

    /** v2.0 嵌套子表（存在时该列为子表容器） */
    private Subtable subtable;
}
