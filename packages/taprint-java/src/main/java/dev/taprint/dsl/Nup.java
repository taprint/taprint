/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;

/**
 * 一页多单（DSL v2.0，schema definitions.nup）：单页按 cols×rows 网格排布多份单据内容。
 *
 * <p>cols/rows 各 1-4（schema 约束）；gap 为网格间距（带单位 length）。
 */
@Data
public class Nup implements Serializable {

    private static final long serialVersionUID = 1L;

    /** 横向份数（1-4） */
    private Integer cols;

    /** 纵向份数（1-4） */
    private Integer rows;

    /** 网格间距，如 "6mm" */
    private String gap;
}
