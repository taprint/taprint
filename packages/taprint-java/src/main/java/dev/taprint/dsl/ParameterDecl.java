/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;

/**
 * 运行时参数声明（copies/printer/silent）。
 */
@Data
public class ParameterDecl implements Serializable {

    private static final long serialVersionUID = 1L;

    private String name;
    private String type;
    private Object defaultValue;
    private Number min;
    private Number max;
    private String description;

    /** fastjson: DSL 中键名为 default（保留字规避） */
    public void setDefault(Object value) {
        this.defaultValue = value;
    }

    public Object getDefault() {
        return defaultValue;
    }
}
