/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;

/**
 * 表格合计区项（label + 表达式 value）。
 */
@Data
public class TableSummaryItem implements Serializable {

    private static final long serialVersionUID = 1L;

    private String label;
    private String value;
    private String align;
}
