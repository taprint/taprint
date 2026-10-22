/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import dev.taprint.dsl.DataSourceDecl;
import dev.taprint.dsl.TemplateDsl;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
  * Helpers to read the field dictionary out of a template DSL's data-source schemas.
 * primary 源根级平铺。
 */
public class TemplateDslParser {

    public List<FieldEntry> extractFields(TemplateDsl dsl) {
        List<FieldEntry> fields = new ArrayList<>();
        if (dsl == null || dsl.getDataSources() == null) {
            return fields;
        }
        for (DataSourceDecl ds : dsl.getDataSources()) {
            if (ds.getSchema() == null) {
                continue;
            }
            boolean detail = "detail".equals(ds.getType());
            String prefix = detail ? ds.getName() + "[*]." : "";
            flatten(prefix, ds.getSchema(), fields, ds.getName(), ds.getType());
        }
        return fields;
    }

    @SuppressWarnings("unchecked")
    private void flatten(String prefix, Map<String, Object> schema, List<FieldEntry> out,
                         String sourceName, String sourceType) {
        for (Map.Entry<String, Object> e : schema.entrySet()) {
            String path = prefix + e.getKey();
            if (e.getValue() instanceof Map) {
                flatten(path + ".", (Map<String, Object>) e.getValue(), out, sourceName, sourceType);
            } else {
                FieldEntry entry = new FieldEntry();
                entry.setPath(path);
                entry.setType(e.getValue() == null ? "string" : String.valueOf(e.getValue()));
                entry.setSource(sourceName);
                entry.setSourceType(sourceType);
                out.add(entry);
            }
        }
    }

    public static class FieldEntry {
        private String path;
        private String type;
        private String source;
        private String sourceType;

        public String getPath() {
            return path;
        }

        public void setPath(String path) {
            this.path = path;
        }

        public String getType() {
            return type;
        }

        public void setType(String type) {
            this.type = type;
        }

        public String getSource() {
            return source;
        }

        public void setSource(String source) {
            this.source = source;
        }

        public String getSourceType() {
            return sourceType;
        }

        public void setSourceType(String sourceType) {
            this.sourceType = sourceType;
        }
    }
}
