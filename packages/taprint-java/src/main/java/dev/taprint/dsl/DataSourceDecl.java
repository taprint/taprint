/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;
import java.util.Map;

/**
 * 数据源声明（primary 主表 / detail 明细 / reference 关联）。
 *
 * <p>schema 为字段字典：叶子值为类型名（string/number/integer/boolean/date/datetime/enum），
 * 嵌套对象为子结构。
 */
@Data
public class DataSourceDecl implements Serializable {

    private static final long serialVersionUID = 1L;

    private String name;
    private String type;
    private Map<String, Object> schema;
}
