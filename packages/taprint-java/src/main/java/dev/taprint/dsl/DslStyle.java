/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;

/**
 * 元素样式（继承链 page → body → element，子级覆盖父级）。
 *
 * <p>fontSize 双形态：number（pt，doc/label）或字符串枚举（normal/double/quadruple，receipt）。
 */
@Data
public class DslStyle implements Serializable {

    private static final long serialVersionUID = 1L;

    private String fontFamily;
    private Object fontSize;
    private Boolean bold;
    private Boolean italic;
    private Boolean underline;
    private String color;
    private String backgroundColor;
    private String align;
    private String verticalAlign;
    private BoxEdges border;
    private BoxEdges padding;
}
