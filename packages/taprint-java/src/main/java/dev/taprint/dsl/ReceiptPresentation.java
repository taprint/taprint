/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;
import java.util.List;

/**
 * ESC/POS 小票呈现（流式，无坐标）。
 */
@Data
public class ReceiptPresentation implements Serializable {

    private static final long serialVersionUID = 1L;

    /** 纸宽，如 "80mm"/"58mm"（决定每行字符列数的参照） */
    private String width;
    /** gbk/utf-8 */
    private String encoding;
    /** 如 ["ESC @", "ESC ! 0"] */
    private List<String> initCommands;
    /** 如 ["GS V 1"] */
    private List<String> tailCommands;
    private List<DslElement> body;
}
