/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;
import java.util.List;

/**
 * 标签呈现（绝对坐标，元素必带 x/y）。
 *
 * <p>同一 DSL 由 TsplRenderer/ZplRenderer/CpclRenderer 按设备 dialect 消费。
 */
@Data
public class LabelPresentation implements Serializable {

    private static final long serialVersionUID = 1L;

    private PageSpec size;
    private String gap;
    private Integer density;
    private Integer speed;
    private List<DslElement> body;
    /** 表达式，如 "{{copies | default:1}}" */
    private String copies;
    private String endCommand;
}
