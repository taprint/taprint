/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.barcode;

import com.google.zxing.BarcodeFormat;

/**
 * 一维码制（schema barcode.symbology 枚举，与 ZXing BarcodeFormat 映射）。
 */
public enum Symbology {

    CODE128(BarcodeFormat.CODE_128, 73),
    EAN13(BarcodeFormat.EAN_13, 67),
    EAN8(BarcodeFormat.EAN_8, 68),
    UPC(BarcodeFormat.UPC_A, 65),
    CODE39(BarcodeFormat.CODE_39, 69),
    ITF(BarcodeFormat.ITF, 70);

    private final BarcodeFormat zxingFormat;
    /** ESC/POS GS k 功能 B 函数码（m = 65..73） */
    private final int escPosFunctionCode;

    Symbology(BarcodeFormat zxingFormat, int escPosFunctionCode) {
        this.zxingFormat = zxingFormat;
        this.escPosFunctionCode = escPosFunctionCode;
    }

    public BarcodeFormat getZxingFormat() {
        return zxingFormat;
    }

    public int getEscPosFunctionCode() {
        return escPosFunctionCode;
    }

    public static Symbology of(String name) {
        if (name == null) {
            return CODE128;
        }
        for (Symbology s : values()) {
            if (s.name().equalsIgnoreCase(name.trim())) {
                return s;
            }
        }
        return CODE128;
    }
}
