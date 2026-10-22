/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import dev.taprint.dsl.DocPresentation;
import dev.taprint.dsl.LabelPresentation;
import dev.taprint.dsl.ReceiptPresentation;
import dev.taprint.dsl.Watermark;
import dev.taprint.core.DeviceClass;
import lombok.Data;

import java.util.List;

/**
 * 求值后的模板（编排层产出，渲染器消费）。
 *
 * <p>doc 使用 header/body/footer 三段；receipt/label 仅 body。
 * 呈现规格（page/size/gap 等静态部分）保留原始 DSL 对象，渲染器直接读取。
 *
 * <p>loop/conditional 容器元素在求值期展平为普通元素，
 * 不出现在 header/body/footer 列表中，渲染器零感知。
 */
@Data
public class EvaluatedTemplate {

    private DeviceClass deviceClass;
    private DocPresentation doc;
    private ReceiptPresentation receipt;
    private LabelPresentation label;

    private List<EvaluatedElement> header;
    private List<EvaluatedElement> body;
    private List<EvaluatedElement> footer;

    /**
     * 页面水印求值产物（doc 呈现；src 表达式已求值，text 为字面文字）。
     * 为 null 表示无水印。nup 为纯静态规格，渲染器从 doc.page 直接读取。
     */
    private Watermark watermark;
}
