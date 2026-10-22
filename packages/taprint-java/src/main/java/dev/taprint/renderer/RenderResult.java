/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import dev.taprint.core.CommandSet;

/**
 * 渲染产物（统一构造顺序：payload → mimeType → commandSet，与设计文档全文一致）。
 */
public class RenderResult {

    private final byte[] payload;
    private final String mimeType;
    private final CommandSet commandSet;

    public RenderResult(byte[] payload, String mimeType, CommandSet commandSet) {
        this.payload = payload;
        this.mimeType = mimeType;
        this.commandSet = commandSet;
    }

    public byte[] getPayload() {
        return payload;
    }

    public String getMimeType() {
        return mimeType;
    }

    public CommandSet getCommandSet() {
        return commandSet;
    }

    public int getPayloadSize() {
        return payload == null ? 0 : payload.length;
    }
}
