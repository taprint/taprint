/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import dev.taprint.core.CommandSet;

/**
  * Renderer contract: consume an evaluated template, emit a command stream.
 * <p>数据流契约：表达式求值在编排层完成，渲染器只接收 EvaluatedTemplate
 * （所有 {{...}}、表格列 format、条件分支均已求值为最终展示值），
 * 渲染器内部不再做任何表达式求值。
 */
public interface Renderer {

    CommandSet getCommandSet();

    /**
     * @param evaluated 已完成表达式求值的模板
     * @param ctx       呈现规格 + 设备档案 + locale + 份数
     */
    RenderResult render(EvaluatedTemplate evaluated, RenderContext ctx);
}
