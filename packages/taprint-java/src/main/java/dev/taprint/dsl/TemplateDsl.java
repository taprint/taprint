/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;
import java.util.List;
import java.util.Map;

/**
  * Top-level structure of a taprint template DSL document.
 * <p>顶层禁止出现 tenantId/storeId（schema not 子句），归属由服务端注入。
 */
@Data
public class TemplateDsl implements Serializable {

    private static final long serialVersionUID = 1L;

    private String schemaVersion;
    private String id;
    /** 业务单据代码（注册表驱动，由 BizTypeRegistry 校验有效性） */
    private String code;
    private String name;
    private String category;
    private String description;
    private List<String> locales;
    private List<DataSourceDecl> dataSources;
    private Presentations presentations;
    private List<ParameterDecl> parameters;
    private Map<String, Map<String, String>> i18n;
    private Map<String, Object> extensions;

    public boolean isV2() {
        return schemaVersion != null && schemaVersion.startsWith("2.");
    }
}
