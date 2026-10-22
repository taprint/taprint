/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import lombok.Data;

/**
  * Device profile: the rendering-relevant view of a printer.
 * <p>dialect 决定渲染器路由；capabilities 供渲染器消费
 */
@Data
public class DeviceProfile {

    private Long deviceId;
    private String deviceName;
    /** escpos/tspl/zpl/cpcl/pcl */
    private String dialect;
    private EscPosCapability escPos;

    /** 客户端透传键（渲染器不读，随响应带给执行器层） */
    private Boolean supportsCut;
    private Boolean supportsCashDrawer;
}
