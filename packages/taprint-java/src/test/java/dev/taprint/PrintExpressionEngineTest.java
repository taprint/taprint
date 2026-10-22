/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import dev.taprint.core.PrintKernelException;
import dev.taprint.core.KernelOptions;
import dev.taprint.expression.FilterRegistry;
import dev.taprint.expression.HostFunctions;
import dev.taprint.expression.PrintExpressionEvaluator;
import dev.taprint.expression.QLExpress4Engine;
import dev.taprint.expression.RenderBudget;
import dev.taprint.expression.SandboxPolicy;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PrintExpressionEngineTest {

    private QLExpress4Engine engine;
    private FilterRegistry filters;
    private PrintExpressionEvaluator evaluator;
    private SandboxPolicy sandboxPolicy;
    private KernelOptions options;

    @BeforeEach
    void setUp() {
        options = new KernelOptions();
        filters = new FilterRegistry();
        sandboxPolicy = new SandboxPolicy(options);
        engine = new QLExpress4Engine(sandboxPolicy, filters, HostFunctions.EMPTY);
        evaluator = new PrintExpressionEvaluator(engine, filters, sandboxPolicy, options);
    }

    private Map<String, Object> salesData() {
        Map<String, Object> data = new HashMap<>();
        data.put("billNo", "SN20260806001");
        data.put("billDate", "2026-08-06 14:30:00");
        data.put("totalAmount", new BigDecimal("100.00"));
        data.put("discount", new BigDecimal("10.00"));
        data.put("paidAmount", new BigDecimal("80.00"));
        Map<String, Object> customer = new HashMap<>();
        customer.put("name", "张三");
        customer.put("phone", "13812348888");
        data.put("customer", customer);
        List<Map<String, Object>> items = new ArrayList<>();
        items.add(item("SKU001", "苹果", 2, new BigDecimal("5.00"), new BigDecimal("10.00")));
        items.add(item("SKU002", "香蕉", 3, new BigDecimal("4.00"), new BigDecimal("12.00")));
        data.put("items", items);
        return data;
    }

    private Map<String, Object> item(String sku, String name, int qty, BigDecimal price, BigDecimal amount) {
        Map<String, Object> m = new HashMap<>();
        m.put("sku", sku);
        m.put("name", name);
        m.put("qty", qty);
        m.put("price", price);
        m.put("amount", amount);
        return m;
    }

    private List<Map<String, Object>> scopes(Map<String, Object> data) {
        List<Map<String, Object>> scopes = new ArrayList<>();
        scopes.add(data);
        return scopes;
    }

    private Object eval(String expr, Map<String, Object> data) {
        return evaluator.evalExpression(expr, scopes(data),
                new RenderBudget(5000, 100000));
    }

    @Test
    @DisplayName("TC-EXPR-001 变量解析")
    void test_variable() {
        assertEquals("SN20260806001", eval("billNo", salesData()));
    }

    @Test
    @DisplayName("TC-EXPR-002 嵌套路径")
    void test_nestedPath() {
        assertEquals("张三", eval("customer.name", salesData()));
    }

    @Test
    @DisplayName("TC-EXPR-003 数组下标")
    void test_arrayIndex() {
        assertEquals("SKU001", eval("items[0].sku", salesData()));
        assertEquals("香蕉", eval("items.1.name", salesData()));
    }

    @Test
    @DisplayName("TC-EXPR-004 date 过滤")
    void test_dateFilter() {
        assertEquals("2026-08-06", eval("billDate | date:'YYYY-MM-DD'", salesData()));
        assertEquals("2026-08-06 14:30", eval("billDate | date:'YYYY-MM-DD HH:mm'", salesData()));
    }

    @Test
    @DisplayName("TC-EXPR-005 currency 过滤")
    void test_currencyFilter() {
        assertEquals("￥100.00", eval("totalAmount | currency:CNY", salesData()));
        assertEquals("￥1,234.50", eval("1234.5 | currency:CNY", salesData()));
    }

    @Test
    @DisplayName("TC-EXPR-006 sum 聚合")
    void test_sumFilter() {
        assertEquals(0, new BigDecimal("22.00").compareTo(
                new BigDecimal(String.valueOf(eval("items | sum:'amount'", salesData())))));
    }

    @Test
    @DisplayName("TC-EXPR-006b count/round/truncate/mask/default")
    void test_otherFilters() {
        Map<String, Object> data = salesData();
        data.put("longText", "这是一段很长的文本内容");
        assertEquals(2, eval("items | count", data));
        assertEquals("11.00", eval("10.999 | round:2", data).toString());
        assertEquals("这是...", eval("longText | truncate:5", data));
        assertEquals("138****8888", eval("customer.phone | mask:'138****8888'", data));
        assertEquals("fallback", eval("missing | default:'fallback'", data));
    }

    @Test
    @DisplayName("TC-EXPR-007 算术运算")
    void test_arithmetic() {
        assertEquals(0, new BigDecimal("90.00").compareTo(new BigDecimal(
                String.valueOf(eval("totalAmount - discount", salesData())))));
        assertEquals(0, new BigDecimal("10.00").compareTo(new BigDecimal(
                String.valueOf(eval("items[0].qty * items[0].price", salesData())))));
    }

    @Test
    @DisplayName("TC-EXPR-008 三元")
    void test_ternary() {
        assertEquals("欠款", eval("paidAmount < totalAmount ? '欠款' : '已付'", salesData()));
        assertEquals("欠款", eval("paidAmount >= totalAmount ? '已付' : '欠款'", salesData()));
        assertEquals("已付", eval("paidAmount >= discount ? '已付' : '欠款'", salesData()));
    }

    @Test
    @DisplayName("TC-EXPR-009 #each 循环（含行作用域与 @index）")
    void test_eachLoop() {
        String tpl = "{{#each items}}{{@index}}.{{name}}×{{qty}};{{/each}}";
        String out = evaluator.renderTemplateString(tpl, scopes(salesData()),
                new RenderBudget(5000, 100000));
        assertEquals("0.苹果×2;1.香蕉×3;", out);
    }

    @Test
    @DisplayName("TC-EXPR-009b #each as 别名")
    void test_eachAsAlias() {
        String tpl = "{{#each items as it}}{{it.sku}},{{/each}}";
        String out = evaluator.renderTemplateString(tpl, scopes(salesData()),
                new RenderBudget(5000, 100000));
        assertEquals("SKU001,SKU002,", out);
    }

    @Test
    @DisplayName("TC-EXPR-010 #if 条件")
    void test_ifBlock() {
        String tpl = "{{#if paidAmount < totalAmount}}欠款{{else}}已付{{/if}}";
        assertEquals("欠款", evaluator.renderTemplateString(tpl, scopes(salesData()),
                new RenderBudget(5000, 100000)));
    }

    @Test
    @DisplayName("TC-EXPR-011/012/013 注入拦截（System.exit/Runtime/反射/构造器）")
    void test_injectionRejected() {
        Map<String, Object> data = salesData();
        assertThrows(PrintKernelException.class, () -> eval("System.exit(0)", data));
        assertThrows(PrintKernelException.class, () -> eval("Runtime.getRuntime().exec('rm')", data));
        assertThrows(PrintKernelException.class, () -> eval("Class.forName('java.lang.Runtime')", data));
        assertThrows(PrintKernelException.class, () -> eval("new java.io.FileInputStream('/etc/passwd')", data));
        assertThrows(PrintKernelException.class, () -> eval("billNo.getClass()", data));
    }

    @Test
    @DisplayName("TC-EXPR-014 长循环表达式超时熔断（spike T4 口径）")
    void test_longLoopTimeout() {
        Map<String, Object> data = salesData();
        assertThrows(PrintKernelException.class, () ->
                eval("sum = 0; for (i = 0; i < 100000000; i++) { sum = sum + i }", data));
    }

    @Test
    @DisplayName("TC-EXPR-015 单表达式长度限制（>1KB 拒绝）")
    void test_exprLengthLimit() {
        StringBuilder sb = new StringBuilder("billNo");
        while (sb.length() < 1100) {
            sb.append("+billNo");
        }
        assertThrows(PrintKernelException.class, () -> eval(sb.toString(), salesData()));
    }

    @Test
    @DisplayName("TC-EXPR-016 #each 迭代预算（>100k 拒绝）")
    void test_loopBudget() {
        Map<String, Object> data = new HashMap<>();
        List<Object> big = new ArrayList<>();
        for (int i = 0; i < 1000; i++) {
            big.add("x");
        }
        data.put("a", big);
        data.put("b", big);
        data.put("c", big);
        data.put("d", big);
        data.put("e", big);
        RenderBudget budget = new RenderBudget(60000, 100);
        assertThrows(PrintKernelException.class, () ->
                evaluator.renderTemplateString("{{#each a}}{{#each b}}x{{/each}}{{/each}}",
                        scopes(data), budget));
    }

    @Test
    @DisplayName("TC-EXPR-017 管道编译（| → 过滤器链）")
    void test_pipeline() {
        assertEquals("2026-08-06", eval("billDate | date:'YYYY-MM-DD'", salesData()));
        assertEquals("￥22.00", eval("items | sum:'amount' | currency:CNY", salesData()));
    }

    @Test
    @DisplayName("TC-EXPR-018 DSL 总长限制（>1MB 拒绝）")
    void test_templateSizeLimit() {
        StringBuilder sb = new StringBuilder();
        while (sb.length() < 1048700) {
            sb.append("x");
        }
        assertThrows(PrintKernelException.class, () -> sandboxPolicy.validateTemplate(sb.toString()));
    }

    @Test
    @DisplayName("内置函数白名单（now/uuid 注册；未注册函数拒绝）")
    void test_functionWhitelist() {
        Map<String, Object> data = salesData();
        assertTrue(eval("now()", data) instanceof Date);
        assertTrue(String.valueOf(eval("uuid()", data)).length() >= 32);
        assertThrows(PrintKernelException.class, () -> eval("evil()", data));
    }

    @Test
    @DisplayName("host functions SPI：注册后可调用，未注册显式失败（ADR-0007）")
    void test_hostFunctionsSpi() {
        Map<String, Object> data = salesData();
        // no host functions registered: business identity functions are not built in
        PrintKernelException unregistered = assertThrows(PrintKernelException.class,
                () -> eval("shopName()", data));
        assertTrue(String.valueOf(unregistered.getMessage()).contains("shopName"));

        // registered through the SPI: callable like a builtin
        FilterRegistry filters = new FilterRegistry();
        SandboxPolicy policy = new SandboxPolicy(new dev.taprint.core.KernelOptions());
        QLExpress4Engine engine = new QLExpress4Engine(policy, filters, new HostFunctions() {
            @Override
            public boolean isRegistered(String name) {
                return "shopName".equals(name);
            }

            @Override
            public Object invoke(String name, java.util.List<Object> args) {
                return "demo shop";
            }

            @Override
            public java.util.List<String> declaredNames() {
                return java.util.List.of("shopName");
            }
        });
        assertEquals("demo shop", engine.evaluate("shopName()", data, 1000));
    }

    @Test
    @DisplayName("单表达式超时熔断（QLExpress4 timeoutMillis=100）")
    void test_timeout() {
        Map<String, Object> data = salesData();
        assertThrows(PrintKernelException.class, () ->
                eval("x = 0; for (i = 0; i < 200000000; i++) { x = x + 1 }", data));
    }

    @Test
    @DisplayName("块嵌套深度限制（if≤5/each≤3）")
    void test_blockDepth() {
        dev.taprint.expression.TemplateParser parser =
                new dev.taprint.expression.TemplateParser(sandboxPolicy);
        String deepIf = "{{#if a}}{{#if a}}{{#if a}}{{#if a}}{{#if a}}{{#if a}}x{{/if}}{{/if}}{{/if}}{{/if}}{{/if}}{{/if}}";
        assertThrows(PrintKernelException.class, () -> parser.parse(deepIf));
        String deepEach = "{{#each a}}{{#each a}}{{#each a}}{{#each a}}x{{/each}}{{/each}}{{/each}}{{/each}}";
        assertThrows(PrintKernelException.class, () -> parser.parse(deepEach));
    }

    @Test
    @DisplayName("QLExpress4 语义口径：字符串拼接/真值/缺失变量")
    void test_engineSemantics() {
        Map<String, Object> data = salesData();
        assertEquals("abc1", eval("'abc' + 1", data));
        assertEquals(true, eval("1 < 2", data));
        assertEquals(false, eval("1 > 2", data));
        // QLExpress4 未定义变量 → null（展示层 toDisplayString 归一为空串）
        org.junit.jupiter.api.Assertions.assertNull(eval("missing", data));
    }
}
