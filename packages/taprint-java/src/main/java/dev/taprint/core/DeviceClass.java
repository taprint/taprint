/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.core;

/**
 * Print device class (one of the three DSL presentations).
 */
public enum DeviceClass {

    DOC("doc"),
    RECEIPT("receipt"),
    LABEL("label");

    private final String code;

    DeviceClass(String code) {
        this.code = code;
    }

    public String getCode() {
        return code;
    }

    public static DeviceClass of(String code) {
        if (code == null) {
            return null;
        }
        for (DeviceClass dc : values()) {
            if (dc.code.equalsIgnoreCase(code)) {
                return dc;
            }
        }
        return null;
    }
}
