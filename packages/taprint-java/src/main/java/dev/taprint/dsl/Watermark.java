/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;

/**
 * 页面水印（DSL v2.0，schema definitions.watermark）。
 *
 * <p>type=text 必填 {@link #text}（≤100 字符）；type=image 必填 {@link #src}（表达式）。
 * opacity ∈ (0,1]、angle ∈ [-90,90]；tile=true 平铺整页，false 居中单枚。
 */
@Data
public class Watermark implements Serializable {

    private static final long serialVersionUID = 1L;

    /** text / image */
    private String type;

    /** text 型水印文字 */
    private String text;

    /** image 型水印图源（表达式，求值后为 data URI 或 http URL） */
    private String src;

    /** 不透明度 (0,1]，缺省按渲染器默认 */
    private Double opacity;

    /** 旋转角度 [-90,90]（度） */
    private Double angle;

    /** true=平铺整页；false=居中单枚 */
    private Boolean tile;

    private DslStyle style;
}
