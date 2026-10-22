/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.renderer;

import dev.taprint.core.CommandSet;
import dev.taprint.core.PrintErrorCode;
import dev.taprint.core.PrintKernelException;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * Command-set routing table over the available {@link Renderer}
 * implementations. Framework-free: callers pass the renderer list (see
 * {@code Taprint#standardRenderers} for the default set).
 */
public class RendererRegistry {

    private final Map<CommandSet, Renderer> registry = new EnumMap<>(CommandSet.class);

    public RendererRegistry(List<Renderer> renderers) {
        for (Renderer renderer : renderers) {
            registry.put(renderer.getCommandSet(), renderer);
        }
    }

    public Renderer get(CommandSet commandSet) {
        Renderer renderer = registry.get(commandSet);
        if (renderer == null) {
            throw PrintKernelException.of(PrintErrorCode.COMMAND_SET_MISMATCH,
                    String.valueOf(commandSet));
        }
        return renderer;
    }

    /** Registered command sets (useful for capability reporting/tests). */
    public List<CommandSet> registeredCommandSets() {
        return new ArrayList<>(registry.keySet());
    }
}
