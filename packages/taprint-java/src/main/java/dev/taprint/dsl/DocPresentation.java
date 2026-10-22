/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.dsl;

import lombok.Data;

import java.io.Serializable;
import java.util.List;

/**
 * A4 单据呈现（流式三段 section：header/body/footer）。
 */
@Data
public class DocPresentation implements Serializable {

    private static final long serialVersionUID = 1L;

    private PageSpec page;
    private DslStyle style;
    private List<DslElement> header;
    private List<DslElement> body;
    private List<DslElement> footer;
}
