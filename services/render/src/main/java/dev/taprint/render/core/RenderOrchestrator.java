/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.render.core;

import com.alibaba.fastjson.JSON;
import dev.taprint.core.CommandSet;
import dev.taprint.core.DeviceClass;
import dev.taprint.core.PrintErrorCode;
import dev.taprint.core.PrintKernelException;
import dev.taprint.dsl.LabelPresentation;
import dev.taprint.dsl.TemplateDsl;
import dev.taprint.render.config.RenderProperties;
import dev.taprint.render.web.ApiException;
import dev.taprint.renderer.DeviceProfile;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.EscPosCapability;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import dev.taprint.validation.TemplateDslValidator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Orchestrates one render inside the bounded worker pool with the hard
 * wall-clock budget (ADR-0012). Pipeline: sandbox gate → DSL parse +
 * structural validation → kernel eval → kernel render → output cap →
 * frame summary. Every failure surfaces as an explicit 4xx.
 */
@Component
public class RenderOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(RenderOrchestrator.class);

    private final ThreadPoolExecutor workers;
    private final RenderKernel kernel;
    private final RenderProperties props;

    public RenderOrchestrator(ThreadPoolExecutor workers, RenderKernel kernel, RenderProperties props) {
        this.workers = workers;
        this.kernel = kernel;
        this.props = props;
    }

    public RenderedOutput render(RenderRequest req) {
        CommandSet commandSet = commandSetOf(req.target);
        DeviceClass deviceClass = commandSet == CommandSet.ESC_POS ? DeviceClass.RECEIPT : DeviceClass.LABEL;
        int copies = req.copies == null ? 1 : req.copies;
        if (deviceClass == DeviceClass.RECEIPT && req.copies != null) {
            // Mirrors the MCP compile contract: ESC/POS receipts have no copies
            // command (copies = host re-sends the whole frame).
            throw ApiException.unprocessable("option-not-supported",
                    "options.copies applies to label targets only; ESC/POS receipts are re-sent by the host");
        }

        TemplateDsl dsl = parseDsl(req);

        // options.widthMm overrides the label size width (mirrors the MCP
        // compile contract); for ESC/POS receipts it selects the column profile.
        if (req.widthMm != null && deviceClass == DeviceClass.LABEL
                && dsl.getPresentations().getLabel() != null
                && dsl.getPresentations().getLabel().getSize() != null) {
            dsl.getPresentations().getLabel().getSize().setWidth(stripMm(req.widthMm));
        }
        DeviceProfile profile = deviceProfile(deviceClass, req.widthMm);

        Map<String, Object> parameters = new HashMap<>();
        if (req.dpi != null) {
            parameters.put("dpi", req.dpi);
        }
        if (req.widthMm != null) {
            parameters.put("widthMm", req.widthMm);
        }

        Future<RenderedOutput> future;
        try {
            future = workers.submit(() -> doRender(commandSet, deviceClass, dsl, profile, parameters, req, copies));
        } catch (RejectedExecutionException e) {
            throw new ApiException("worker-saturated", org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,
                    "Render worker pool and queue are saturated; retry later");
        }
        try {
            return future.get(props.getWallClockMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            future.cancel(true); // kernel renderers check the interrupt flag between frames
            throw ApiException.unprocessable("wall-clock-exceeded",
                    "Render exceeded the wall-clock budget of " + props.getWallClockMillis() + " ms and was cancelled");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            future.cancel(true);
            throw new ApiException("interrupted", org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,
                    "Render cancelled by shutdown");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            if (cause instanceof ApiException api) {
                throw api;
            }
            if (cause instanceof PrintKernelException kernelError) {
                throw renderFailed(kernelError);
            }
            log.warn("Unexpected render failure", cause);
            throw ApiException.unprocessable("render-failed", "Kernel render failed: " + cause.getClass().getSimpleName());
        }
    }

    /**
     * PNG preview. The Java kernel's current capability is command streams and
     * PDF; there is no raster pipeline yet, so preview answers an explicit 422
     * instead of degrading to another format (contract: 能力外 4xx).
     */
    public RenderedOutput preview(RenderRequest req) {
        throw ApiException.unprocessable("preview-unsupported",
                "PNG preview is outside the current kernel capability "
                        + "(command streams and PDF only); no silent format substitution");
    }

    private RenderedOutput doRender(CommandSet commandSet, DeviceClass deviceClass, TemplateDsl dsl,
                                    DeviceProfile profile, Map<String, Object> parameters,
                                    RenderRequest req, int copies) {
        EvaluatedTemplate evaluated = kernel.eval(dsl, deviceClass, req.data);
        RenderContext ctx = RenderContext.builder()
                .copies(copies)
                .deviceProfile(profile)
                .parameters(parameters)
                .build();
        RenderResult result = kernel.render(commandSet, evaluated, ctx);
        if (result.getPayloadSize() > props.getOutputMaxBytes()) {
            throw ApiException.payloadTooLarge("output-too-large",
                    "Rendered output " + result.getPayloadSize() + " bytes exceeds the hard cap of "
                            + props.getOutputMaxBytes() + " bytes");
        }
        List<String> summary = FrameSummary.build(deviceClass, evaluated, commandSet, copies, req.dpi);
        return new RenderedOutput(result.getPayload(), result.getMimeType(), summary);
    }

    private CommandSet commandSetOf(String target) {
        return switch (target) {
            case "escpos" -> CommandSet.ESC_POS;
            case "tspl" -> CommandSet.TSPL;
            case "cpcl" -> CommandSet.CPCL;
            case "zpl" -> throw ApiException.unprocessable("target-unsupported",
                    "target=zpl is contract-valid but the Java kernel does not ship a ZPL renderer yet "
                            + "(ADR-0001); no silent dialect substitution");
            default -> throw ApiException.badRequest("unknown-target",
                    "Unknown target '" + target + "' (supported: escpos, tspl, cpcl, zpl)");
        };
    }

    private TemplateDsl parseDsl(RenderRequest req) {
        List<String> sandbox = SandboxGate.scan(req.templateJson);
        if (!sandbox.isEmpty()) {
            throw ApiException.unprocessable("sandbox-violation", sandbox.get(0));
        }
        TemplateDsl dsl;
        try {
            dsl = JSON.parseObject(req.templateJson, TemplateDsl.class);
        } catch (Exception e) {
            throw ApiException.unprocessable("template-invalid",
                    "Template DSL is not parseable: " + firstLine(e.getMessage()));
        }
        if (dsl == null || dsl.getPresentations() == null) {
            throw ApiException.unprocessable("template-invalid",
                    "Template DSL must carry a presentations object");
        }
        List<String> errors = new TemplateDslValidator().validateJson(req.templateJson);
        if (!errors.isEmpty()) {
            throw ApiException.unprocessable("template-invalid", "Template DSL failed structural validation",
                    errors.subList(0, Math.min(5, errors.size())));
        }
        return dsl;
    }

    private DeviceProfile deviceProfile(DeviceClass deviceClass, Double widthMm) {
        DeviceProfile profile = new DeviceProfile();
        if (deviceClass == DeviceClass.RECEIPT) {
            EscPosCapability cap = EscPosCapability.defaults();
            double mm = widthMm == null ? 80.0 : widthMm;
            cap.setMaxWidthCols(mm >= 72.0 ? 48 : 32);
            profile.setEscPos(cap);
        }
        return profile;
    }

    private ApiException renderFailed(PrintKernelException e) {
        PrintErrorCode code = e.getErrorCode();
        if (code == PrintErrorCode.TEMPLATE_PRESENTATION_MISSING) {
            return ApiException.unprocessable("missing-presentation",
                    "Template has no '" + firstLine(e.getMessage()) + "' presentation for the requested target");
        }
        if (code == PrintErrorCode.SANDBOX_VIOLATION || code.name().startsWith("EXPRESSION")
                || code == PrintErrorCode.BLOCK_DEPTH_EXCEEDED || code == PrintErrorCode.LOOP_BUDGET_EXCEEDED) {
            return ApiException.unprocessable("sandbox-violation", "Template expression rejected by the sandbox",
                    List.of((code == null ? "UNKNOWN" : code.getCode()) + ": " + firstLine(e.getMessage())));
        }
        String detail = (code == null ? "UNKNOWN" : code.getCode()) + ": " + firstLine(e.getMessage());
        return ApiException.unprocessable("render-failed", "Kernel render failed", List.of(detail));
    }

    private static String stripMm(double widthMm) {
        double rounded = Math.round(widthMm * 100.0) / 100.0;
        String s = String.valueOf(rounded);
        return s.endsWith(".0") ? s.substring(0, s.length() - 2) : s;
    }

    private static String firstLine(String msg) {
        if (msg == null) {
            return "";
        }
        int nl = msg.indexOf('\n');
        return nl > 0 ? msg.substring(0, nl) : msg;
    }
}
