/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;

/**
 * 三种呈现（deviceClass 一一对应），至少存在一种。
 */
@Data
public class Presentations implements Serializable {

    private static final long serialVersionUID = 1L;

    private DocPresentation doc;
    private ReceiptPresentation receipt;
    private LabelPresentation label;
}
