/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;

/**
 * 四边距/边框（带单位 length 字符串，如 "15mm"/"0.5pt"）。
 */
@Data
public class BoxEdges implements Serializable {

    private static final long serialVersionUID = 1L;

    private String top;
    private String right;
    private String bottom;
    private String left;
}
