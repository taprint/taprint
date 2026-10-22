/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import dev.taprint.dsl.TemplateDsl;
import lombok.Builder;
import lombok.Data;

import java.util.Locale;
import java.util.Map;

/**
  * Render context: presentation selection, device profile, locale and copies.
 * <p>呈现规格按 deviceClass 从 DSL 选取；设备档案按 printerId 查得（可空）；
 * parameters 为运行时参数（copies/printer/silent）。
 */
@Data
@Builder
public class RenderContext {

    private TemplateDsl dsl;
    /** 设备档案（doc 可为 null；receipt/label 无设备档案时为默认能力） */
    private DeviceProfile deviceProfile;
    private Locale locale;
    private int copies;
    private Map<String, Object> parameters;
    private String traceId;
}
