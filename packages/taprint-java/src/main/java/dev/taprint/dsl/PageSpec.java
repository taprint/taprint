/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;

/**
 * 页面规格（doc page / label size）。
 */
@Data
public class PageSpec implements Serializable {

    private static final long serialVersionUID = 1L;

    /** A4/A5/LETTER/CUSTOM */
    private String size;
    private String width;
    private String height;
    private BoxEdges margin;
    private String orientation;

    /** v2.0 页面水印 */
    private Watermark watermark;

    /** v2.0 一页多单（cols×rows 网格排布） */
    private Nup nup;
}
