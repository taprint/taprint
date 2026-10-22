/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import lombok.Data;

@Data
public class EscPosCapability {

    /** 是否支持 GS ( k 原生 QR */
    private boolean nativeQrCode;
    /** 是否支持 GS ( k 一维码扩展 */
    private boolean gsPK;
    /** 每行字符列数（80mm=42/48/56，58mm=30/32/40），必须来自设备档案实测 */
    private int maxWidthCols = 32;
    /** GS ! 倍率上限（4 或 8） */
    private int maxFontScale = 4;
    /** 默认编码 GBK/UTF-8/BIG5 */
    private String encoding = "GBK";

    public static EscPosCapability defaults() {
        EscPosCapability c = new EscPosCapability();
        c.nativeQrCode = false;
        c.gsPK = false;
        c.maxWidthCols = 32;
        c.maxFontScale = 4;
        c.encoding = "GBK";
        return c;
    }
}
