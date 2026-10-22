/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint;

import com.alibaba.fastjson.JSON;
import dev.taprint.core.KernelOptions;
import dev.taprint.dsl.TemplateDsl;
import dev.taprint.expression.FilterRegistry;
import dev.taprint.expression.PrintExpressionEvaluator;
import dev.taprint.expression.HostFunctions;
import dev.taprint.expression.QLExpress4Engine;
import dev.taprint.expression.SandboxPolicy;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class PrintTestFixturetures {

    private PrintTestFixturetures() {
    }

    public static String readResource(String path) throws Exception {
        InputStream in = PrintTestFixturetures.class.getClassLoader().getResourceAsStream(path);
        if (in == null) {
            throw new IllegalStateException("测试资源不存在: " + path);
        }
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            in.close();
        }
    }

    public static TemplateDsl loadDsl(String path) throws Exception {
        return JSON.parseObject(readResource(path), TemplateDsl.class);
    }

    /**
     * date/datetime→2026-01-15 固定值保证 golden 可复现）。
     */
    public static Map<String, Object> escPosReceiptMockData() {
        Map<String, Object> data = new HashMap<>();
        data.put("billNo", "示例-billNo");
        data.put("billDate", "2026-01-15 10:30:00");
        Map<String, Object> store = new HashMap<>();
        store.put("name", "示例-store.name");
        store.put("phone", "示例-store.phone");
        data.put("store", store);
        data.put("cashier", "示例-cashier");
        data.put("totalAmount", new BigDecimal("38.00"));
        data.put("discount", new BigDecimal("3.00"));
        data.put("paidAmount", new BigDecimal("40.00"));
        data.put("changeAmount", new BigDecimal("5.00"));
        data.put("payMethod", "示例-payMethod");

        List<Map<String, Object>> items = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            Map<String, Object> item = new HashMap<>();
            item.put("name", "示例-items.name-" + i);
            item.put("qty", 12.5 + i);
            item.put("price", 12.5 + i);
            item.put("amount", new BigDecimal("12.50").add(new BigDecimal(i)));
            items.add(item);
        }
        data.put("items", items);

        Map<String, Object> main = new HashMap<>(data);
        main.remove("items");
        data.put("main", main);
        data.put("copies", 1);
        data.put("silent", true);
        return data;
    }

    public static PrintExpressionEvaluator newEvaluator() {
        KernelOptions options = new KernelOptions();
        SandboxPolicy sandboxPolicy = new SandboxPolicy(options);
        FilterRegistry filters = new FilterRegistry();
        QLExpress4Engine engine = new QLExpress4Engine(sandboxPolicy, filters, HostFunctions.EMPTY);
        return new PrintExpressionEvaluator(engine, filters, sandboxPolicy, options);
    }

    /**
     * inventory-report-v2.0.json 确定性 mock 数据（与 dataSources 声明对齐：
     * main primary / items detail / batches detail）。
     * 3 个商品行分 2 组（食品×2、日用×1），批次 2 条，diffTotal>0 触发 conditional 真分支。
     */
    public static Map<String, Object> inventoryReportMockData() {
        Map<String, Object> data = new HashMap<>();
        data.put("billNo", "PD20260809001");
        data.put("billDate", "2026-01-15");
        data.put("warehouse", "一号仓");
        data.put("checker", "张三");
        data.put("diffTotal", new BigDecimal("12.50"));
        data.put("remark", "示例-remark");

        List<Map<String, Object>> items = new ArrayList<>();
        items.add(item("食品", "SKU001", "大米", 10, 100, 12, new BigDecimal("100.00")));
        items.add(item("食品", "SKU002", "面粉", 5, 50, 4, new BigDecimal("50.00")));
        items.add(item("日用", "SKU003", "肥皂", 20, 60, 20, new BigDecimal("60.00")));
        data.put("items", items);

        List<Map<String, Object>> batches = new ArrayList<>();
        batches.add(batch("B20260101", 6, "2026-06-01"));
        batches.add(batch("B20260102", 6, "2026-07-01"));
        data.put("batches", batches);
        return data;
    }

    private static Map<String, Object> item(String category, String sku, String name,
                                            int bookQty, int amount, int realQty, BigDecimal amountDecimal) {
        Map<String, Object> m = new HashMap<>();
        m.put("category", category);
        m.put("sku", sku);
        m.put("name", name);
        m.put("bookQty", bookQty);
        m.put("amount", amountDecimal);
        m.put("realQty", realQty);
        m.put("diffQty", realQty - bookQty);
        return m;
    }

    private static Map<String, Object> batch(String batchNo, int qty, String expireDate) {
        Map<String, Object> m = new HashMap<>();
        m.put("batchNo", batchNo);
        m.put("qty", qty);
        m.put("expireDate", expireDate);
        return m;
    }

    /**
     * coupon-sheet-v2.0.json 确定性 mock 数据（logoUrl 用 data URI 1x1 PNG，
     * 避免测试依赖外网；image 水印按此加载）。
     */
    public static Map<String, Object> couponSheetMockData() {
        Map<String, Object> data = new HashMap<>();
        data.put("couponNo", "CP20260809001");
        data.put("faceValue", new BigDecimal("50.00"));
        data.put("expireDate", "2026-12-31");
        // 1x1 透明 PNG（base64）
        data.put("logoUrl", "data:image/png;base64,"
                + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
                + "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");
        return data;
    }
}
