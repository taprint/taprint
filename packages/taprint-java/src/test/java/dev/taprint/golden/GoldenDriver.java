/*
 * SPDX-License-Identifier: Apache-2.0
 */
package dev.taprint.golden;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import dev.taprint.barcode.BarcodeRenderer;
import dev.taprint.barcode.QrcodeRenderer;
import dev.taprint.core.CommandSet;
import dev.taprint.dsl.DslStyle;
import dev.taprint.dsl.LabelPresentation;
import dev.taprint.dsl.PageSpec;
import dev.taprint.dsl.ReceiptPresentation;
import dev.taprint.renderer.CjkRasterizer;
import dev.taprint.renderer.CpclRenderer;
import dev.taprint.renderer.DeviceProfile;
import dev.taprint.renderer.EscPosCapability;
import dev.taprint.renderer.EscPosRenderer;
import dev.taprint.renderer.EvaluatedElement;
import dev.taprint.renderer.EvaluatedTemplate;
import dev.taprint.renderer.PrintImageLoader;
import dev.taprint.renderer.RenderContext;
import dev.taprint.renderer.RenderResult;
import dev.taprint.renderer.TsplRenderer;
import dev.taprint.renderer.ZplRenderer;

import java.util.ArrayList;
import java.util.List;

/**
 * Golden 驱动器：canonical 用例 → {@link EvaluatedTemplate} → 真实渲染器。
 *
 * <p>Java 为参照实现（ADR-0010）：expected 工件由本驱动产出，其他语言对拍。
 */
public final class GoldenDriver {

    /** 单用例单协议渲染结果。 */
    public static final class Outcome {
        public final String caseId;
        public final String protocol;
        public final byte[] payload;
        public final String framesText;
        public final String sha256;

        Outcome(String caseId, String protocol, byte[] payload, String framesText, String sha256) {
            this.caseId = caseId;
            this.protocol = protocol;
            this.payload = payload;
            this.framesText = framesText;
            this.sha256 = sha256;
        }
    }

    private GoldenDriver() {
    }

    /** 渲染一个用例的全部协议。 */
    public static List<Outcome> run(GoldenCaseModel.Case c) {
        List<Outcome> outcomes = new ArrayList<>();
        for (String protocol : c.protocols) {
            outcomes.add(renderOne(c, protocol));
        }
        return outcomes;
    }

    private static Outcome renderOne(GoldenCaseModel.Case c, String protocol) {
        RenderResult result = rendererFor(protocol).render(
                toEvaluated(c, protocol),
                RenderContext.builder().copies(copiesOf(c)).deviceProfile(profileFor(c, protocol)).build());
        List<GoldenFrames.Frame> frames;
        if ("tspl".equals(protocol)) {
            frames = GoldenFrames.tspl(result.getPayload());
        } else if ("cpcl".equals(protocol)) {
            frames = GoldenFrames.cpcl(result.getPayload());
        } else if ("zpl".equals(protocol)) {
            frames = GoldenFrames.zpl(result.getPayload());
        } else {
            frames = GoldenFrames.escpos(result.getPayload());
        }
        return new Outcome(c.id, protocol, result.getPayload(),
                GoldenFrames.render(frames), sha256Hex(result.getPayload()));
    }

    private static int copiesOf(GoldenCaseModel.Case c) {
        return c.input.containsKey("copies") ? c.input.getIntValue("copies") : 1;
    }

    private static dev.taprint.renderer.Renderer rendererFor(String protocol) {
        CjkRasterizer rasterizer = new CjkRasterizer();
        PrintImageLoader imageLoader = new PrintImageLoader();
        switch (protocol) {
            case "tspl":
                return new TsplRenderer(imageLoader, rasterizer);
            case "cpcl":
                return new CpclRenderer(rasterizer, imageLoader);
            case "zpl":
                return new ZplRenderer();
            case "escpos":
                return new EscPosRenderer(new QrcodeRenderer(new BarcodeRenderer()), imageLoader, rasterizer);
            default:
                throw new IllegalArgumentException("未知协议: " + protocol);
        }
    }

    private static DeviceProfile profileFor(GoldenCaseModel.Case c, String protocol) {
        if (!"escpos".equals(protocol)) {
            return null;
        }
        DeviceProfile profile = new DeviceProfile();
        EscPosCapability cap = EscPosCapability.defaults();
        JSONObject receipt = c.input.getJSONObject("receipt");
        if (receipt != null) {
            cap.setMaxWidthCols(receipt.getIntValue("widthCols"));
            cap.setEncoding(receipt.containsKey("encoding") ? receipt.getString("encoding") : "GBK");
            cap.setNativeQrCode(!Boolean.FALSE.equals(receipt.getBoolean("nativeQr")));
        }
        profile.setEscPos(cap);
        return profile;
    }

    /** canonical 输入 → EvaluatedTemplate（构造式，不经表达式求值——golden 钉帧不钉求值）。 */
    public static EvaluatedTemplate toEvaluated(GoldenCaseModel.Case c, String protocol) {
        EvaluatedTemplate template = new EvaluatedTemplate();
        if ("receipt".equals(c.profile)) {
            ReceiptPresentation receipt = new ReceiptPresentation();
            JSONObject spec = c.input.getJSONObject("receipt");
            if (spec != null) {
                receipt.setWidth(spec.getString("width"));
                receipt.setEncoding(spec.getString("encoding"));
                JSONArray init = spec.getJSONArray("initCommands");
                if (init != null) {
                    receipt.setInitCommands(init.toJavaList(String.class));
                }
                JSONArray tail = spec.getJSONArray("tailCommands");
                if (tail != null) {
                    receipt.setTailCommands(tail.toJavaList(String.class));
                }
            }
            template.setReceipt(receipt);
        } else {
            LabelPresentation label = new LabelPresentation();
            JSONObject spec = c.input.getJSONObject("label");
            if (spec != null) {
                PageSpec size = new PageSpec();
                size.setWidth(spec.getString("width"));
                size.setHeight(spec.getString("height"));
                label.setSize(size);
                label.setGap(spec.getString("gap"));
                label.setDensity(spec.getInteger("density"));
                label.setSpeed(spec.getInteger("speed"));
            }
            template.setLabel(label);
        }
        template.setBody(elementsOf(c));
        return template;
    }

    private static List<EvaluatedElement> elementsOf(GoldenCaseModel.Case c) {
        List<EvaluatedElement> out = new ArrayList<>();
        JSONArray body = c.input.getJSONArray("body");
        if (body == null) {
            return out;
        }
        for (Object item : body) {
            JSONObject el = (JSONObject) item;
            EvaluatedElement element = new EvaluatedElement();
            element.setType(el.getString("type"));
            element.setText(el.getString("text"));
            element.setAlign(el.getString("align"));
            element.setX(el.getString("x"));
            element.setY(el.getString("y"));
            element.setWidth(el.getString("width"));
            element.setHeight(el.getString("height"));
            element.setSize(el.getInteger("size"));
            element.setSymbology(el.getString("symbology"));
            element.setFont(el.getString("font"));
            element.setPartial(el.getBoolean("partial"));
            element.setPulse(el.getInteger("pulse"));
            JSONObject style = el.getJSONObject("style");
            if (style != null) {
                DslStyle dslStyle = new DslStyle();
                dslStyle.setFontSize(style.get("fontSize"));
                dslStyle.setBold(style.getBoolean("bold"));
                dslStyle.setAlign(style.getString("align"));
                element.setStyle(dslStyle);
            }
            // table 元素（求值层产物直供：rows 已是格式化字符串）
            JSONArray headers = el.getJSONArray("headers");
            if (headers != null) {
                element.setHeaders(headers.toJavaList(String.class));
            }
            JSONArray columns = el.getJSONArray("columns");
            if (columns != null) {
                List<dev.taprint.dsl.TableColumn> cols = new ArrayList<>();
                for (Object col : columns) {
                    JSONObject colObj = (JSONObject) col;
                    dev.taprint.dsl.TableColumn column = new dev.taprint.dsl.TableColumn();
                    column.setHeader(colObj.getString("header"));
                    column.setWidth(colObj.getString("width"));
                    column.setAlign(colObj.getString("align"));
                    cols.add(column);
                }
                element.setColumns(cols);
            }
            JSONArray rows = el.getJSONArray("rows");
            if (rows != null) {
                List<List<String>> rowList = new ArrayList<>();
                for (Object row : rows) {
                    rowList.add(((JSONArray) row).toJavaList(String.class));
                }
                element.setRows(rowList);
            }
            // humanReadable 为 canonical 层语义位：各协议各自消化（Java TSPL
            // 恒发 human=1、CPCL 无 BARCODE-TEXT、ESC/POS 走 GS H），差异进
            // docs/conformance.md，不在此处改写。
            out.add(element);
        }
        return out;
    }

    public static String sha256Hex(byte[] bytes) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(bytes);
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public static CommandSet commandSetOf(String protocol) {
        switch (protocol) {
            case "tspl":
                return CommandSet.TSPL;
            case "cpcl":
                return CommandSet.CPCL;
            case "zpl":
                return CommandSet.ZPL;
            default:
                return CommandSet.ESC_POS;
        }
    }
}
