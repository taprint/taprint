/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.expression;

import com.alibaba.qlexpress4.Express4Runner;
import com.alibaba.qlexpress4.InitOptions;
import com.alibaba.qlexpress4.QLOptions;
import com.alibaba.qlexpress4.QLResult;
import com.alibaba.qlexpress4.exception.QLException;
import com.alibaba.qlexpress4.exception.QLTimeoutException;
import com.alibaba.qlexpress4.runtime.Parameters;
import com.alibaba.qlexpress4.runtime.QContext;
import com.alibaba.qlexpress4.security.StrategyIsolation;
import dev.taprint.core.PrintErrorCode;
import dev.taprint.core.PrintKernelException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * QLExpress4 expression engine wrapper.
 *
 * <p>Sandboxing: the default StrategyIsolation security strategy plus a
 * per-expression timeout via {@code QLOptions.timeoutMillis}. Filter pipes are
 * compiled into function calls by {@link PipeCompiler} before reaching this
 * engine (QLExpress4 has no native {@code |} operator).</p>
 *
 * <p>Domain constraints: data-bound scopes must be {@code Map} instances
 * (field access on arbitrary Java objects is blocked by the sandbox), and
 * {@code List.size()} is replaced by the kernel-provided {@code len()} /
 * {@code count()} functions.</p>
 *
 * <p>Host functions (ADR-0007): business functions are NOT built in. A host
 * registers its own functions through the {@link HostFunctions} SPI; calls to
 * functions that are neither kernel builtins nor registered fail statically at
 * validation time (see {@link ExpressionAudit}) and explicitly at evaluation
 * time.</p>
 */
public class QLExpress4Engine {

    private static final Logger log = LoggerFactory.getLogger(QLExpress4Engine.class);

    private final SandboxPolicy sandboxPolicy;
    private final FilterRegistry filterRegistry;
    private final HostFunctions hostFunctions;
    private Express4Runner runner;

    public QLExpress4Engine(SandboxPolicy sandboxPolicy, FilterRegistry filterRegistry,
                            HostFunctions hostFunctions) {
        this.sandboxPolicy = sandboxPolicy;
        this.filterRegistry = filterRegistry;
        this.hostFunctions = hostFunctions == null ? HostFunctions.EMPTY : hostFunctions;
        init();
    }

    private void init() {
        InitOptions init = InitOptions.builder()
                .securityStrategy(StrategyIsolation.getInstance())
                .build();
        this.runner = new Express4Runner(init);
        registerFunctions();
        warmUp();
        log.info("taprint QLExpress4 engine initialized (StrategyIsolation sandbox)");
    }

    /**
     * Cold-start warm-up: the first evaluation pays class-loading/JIT costs that
     * can exceed the per-expression timeout, which would spuriously fail the
     * first render. Pre-run each expression shape with a relaxed timeout.
     */
    private void warmUp() {
        QLOptions warmOpts = QLOptions.builder().timeoutMillis(10000).build();
        Map<String, Object> warmCtx = new java.util.HashMap<>();
        List<Integer> warmList = new java.util.ArrayList<>();
        warmList.add(1);
        warmCtx.put("warmList", warmList);
        String[] warmExprs = {
                "1 + 1",
                "(1 < 2 ? 'a' : 'b')",
                "upper('warm')",
                "len(warmList)",
                "warmList[0]",
                "date(now(), 'YYYY-MM-DD')",
                "uuid()",
                "sum(warmList, 'x')",
        };
        for (String expr : warmExprs) {
            try {
                runner.execute(expr, warmCtx, warmOpts);
            } catch (Throwable e) {
                log.warn("Expression engine warm-up expression failed (non-fatal): {} -> {}",
                        expr, e.getMessage());
            }
        }
    }

    private void registerFunctions() {
        // zero-arg builtins (CustomFunction shape; the Function overload needs 1 arg)
        runner.addFunction("now", (qctx, params) -> new Date());
        runner.addFunction("uuid", (qctx, params) -> UUID.randomUUID().toString());

        // single-argument functions (Function<T,R> overload)
        runner.<Object, Object>addFunction("len", this::len);
        runner.<Object, Object>addFunction("upper", (Object s) -> s == null ? "" : String.valueOf(s).toUpperCase());
        runner.<Object, Object>addFunction("lower", (Object s) -> s == null ? "" : String.valueOf(s).toLowerCase());
        runner.<Object, Object>addFunction("count", this::count);

        // filter-pipe functions: delegated to FilterRegistry
        runner.addFunction("date", filterFn("date"));
        runner.addFunction("currency", filterFn("currency"));
        runner.addFunction("round", filterFn("round"));
        runner.addFunction("sum", filterFn("sum"));
        runner.addFunction("avg", filterFn("avg"));
        runner.addFunction("min", filterFn("min"));
        runner.addFunction("max", filterFn("max"));
        runner.addFunction("truncate", filterFn("truncate"));
        runner.addFunction("mask", filterFn("mask"));
        runner.addFunction("default", filterFn("default"));

        // host functions (ADR-0007 SPI): each declared name becomes a callable
        // that forwards into the host registry
        for (String name : hostFunctions.declaredNames()) {
            runner.addFunction(name, (QContext qctx, Parameters params) -> {
                List<Object> args = new ArrayList<>();
                for (int i = 0; i < params.size(); i++) {
                    args.add(params.getValue(i));
                }
                if (!hostFunctions.isRegistered(name)) {
                    throw HostFunctions.unregistered(name);
                }
                return hostFunctions.invoke(name, args);
            });
        }
    }

    /** Names the engine itself provides (input to the static audit). */
    public static List<String> builtinFunctionNames() {
        return List.of("now", "uuid", "len", "upper", "lower", "count",
                "date", "currency", "round", "sum", "avg", "min", "max",
                "truncate", "mask", "default");
    }

    /**
     * Host function names currently callable through this engine. Templates
     * calling any other unknown function fail the static audit; if the host
     * registry cannot enumerate its names the audit falls back to
     * evaluation-time errors only.
     */
    public List<String> hostFunctionNames() {
        return hostFunctions.declaredNames();
    }

    private com.alibaba.qlexpress4.runtime.function.CustomFunction filterFn(String name) {
        return (QContext qctx, Parameters params) -> {
            Object value = params.size() > 0 ? params.getValue(0) : null;
            List<Object> args = new ArrayList<>();
            for (int i = 1; i < params.size(); i++) {
                args.add(params.getValue(i));
            }
            return filterRegistry.apply(name, value, args);
        };
    }

    private Object len(Object arg) {
        if (arg instanceof Collection) {
            return ((Collection<?>) arg).size();
        }
        if (arg instanceof Map) {
            return ((Map<?, ?>) arg).size();
        }
        if (arg instanceof String) {
            return ((String) arg).length();
        }
        return 0;
    }

    private Object count(Object arg) {
        return len(arg);
    }

    /**
     * Evaluate an expression already compiled to QL syntax (pipes converted).
     *
     * @param expr      expression in QL syntax
     * @param context   merged scope data (must be a Map; Java object field
     *                  access is blocked by the sandbox)
     * @param timeoutMs per-expression timeout
     */
    public Object evaluate(String expr, Map<String, Object> context, long timeoutMs) {
        sandboxPolicy.validateExpression(expr);
        QLOptions opts = QLOptions.builder()
                .timeoutMillis(timeoutMillis(timeoutMs))
                .build();
        try {
            QLResult result = runner.execute(expr, context, opts);
            return result.getResult();
        } catch (QLTimeoutException e) {
            throw PrintKernelException.of(PrintErrorCode.EXPRESSION_TIMEOUT, expr);
        } catch (QLException e) {
            throw PrintKernelException.of(PrintErrorCode.EXPRESSION_EVAL_FAILED,
                    expr + " - " + firstLine(e.getMessage()));
        } catch (PrintKernelException e) {
            throw e;
        } catch (Throwable e) {
            // sandbox interceptions and other runtime errors map to the
            // sandbox/eval error codes
            throw PrintKernelException.of(PrintErrorCode.SANDBOX_VIOLATION,
                    expr + " - " + firstLine(e.getMessage()));
        }
    }

    private long timeoutMillis(long timeoutMs) {
        // guard against zero/negative timeouts that would abort every call
        return timeoutMs > 0 ? timeoutMs : 1;
    }

    private String firstLine(String msg) {
        if (msg == null) {
            return "";
        }
        int nl = msg.indexOf('\n');
        return nl > 0 ? msg.substring(0, nl) : msg;
    }

    /** BigDecimal normalization (used by tests and display layers). */
    public static BigDecimal toBig(Object v) {
        return EcmaValue.toBigDecimal((Number) EcmaValue.toNumber(v));
    }
}
