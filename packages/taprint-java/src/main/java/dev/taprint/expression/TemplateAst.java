/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.expression;

import java.util.ArrayList;
import java.util.List;

public class TemplateAst {

    private final List<TemplateNode> nodes = new ArrayList<>();

    public List<TemplateNode> getNodes() {
        return nodes;
    }

    public abstract static class TemplateNode {
    }

    /** 含 {{...}} 占位符的文本段 */
    public static class TextNode extends TemplateNode {
        private final String content;

        public TextNode(String content) {
            this.content = content;
        }

        public String getContent() {
            return content;
        }
    }

    public static class IfNode extends TemplateNode {
        private final String condition;
        private final List<TemplateNode> thenBranch = new ArrayList<>();
        private List<TemplateNode> elseBranch;

        public IfNode(String condition) {
            this.condition = condition;
        }

        public String getCondition() {
            return condition;
        }

        public List<TemplateNode> getThenBranch() {
            return thenBranch;
        }

        public List<TemplateNode> getElseBranch() {
            return elseBranch;
        }

        public void setElseBranch(List<TemplateNode> elseBranch) {
            this.elseBranch = elseBranch;
        }
    }

    public static class EachNode extends TemplateNode {
        private final String source;
        private final String itemName;
        private final String indexName;
        private final List<TemplateNode> body = new ArrayList<>();

        public EachNode(String source, String itemName, String indexName) {
            this.source = source;
            this.itemName = itemName;
            this.indexName = indexName;
        }

        public String getSource() {
            return source;
        }

        public String getItemName() {
            return itemName;
        }

        public String getIndexName() {
            return indexName;
        }

        public List<TemplateNode> getBody() {
            return body;
        }
    }
}
