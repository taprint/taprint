# Schema changelog

All template-DSL schema changes are recorded here. Every change must:
① add a row; ② add fixtures under `fixtures/templates/` (and a negative
case where the change tightens validation); ③ extend the migrators in
all four language packages in the same release.

| Version | Date | Change | Migrator |
|---|---|---|---|
| v2.0 | 2026-08-08 | Chinese-style report shapes (strict superset of v1.0): doc table cell model (headerCell/tableCell rowspan/colspan, diagonal headers ltr/rtl/both + diagonalLabels, multi-row headers, cross-page repeat), group subtotals, master/detail subtables, static rows, page watermarks, n-up imposition, loop/conditional containers. `schemaVersion` pattern splits onto the `^2\.[0-9]+$` track; receipt/label unchanged. `diagonalLabels` requires `diagonal` (same if/then coupling as watermarks). | 1.0→2.0 is a version-declaration step (superset); golden anchors pin it |
| v1.1 | 2026-10-19 | Label field-contract unification: ① element set 4→6 (line/box as single x/y/width/height shapes; box.radius is a right-angle degradation where TSPL has no native arc); ② text.size pinned 1–10 (v1.0's 0 folds to 1); ③ qrcode.size 1–20→1–10, default 4 (matches shipped clamp behavior); ④ barcode symbology narrowed to CODE128/EAN13 for v1.x (more codes open by schema-version+implementation in the same release; legacy v1.0 templates dual-read, no new codes) + humanReadable flag (no implicit default — templates set it explicitly); ⑤ fontRole (auto/cjk/latin) preferred over the legacy device-hint `font`; ⑥ label.copies widened to int \| expression string (integer preferred); ⑦ single root `schemaVersion` axis with a 0.9→1.0→1.1→2.0 migration chain; ⑧ dpi carried by device params, not the schema; ⑨ bare-key field bindings canonical, dotted paths parsed for compatibility | 1.0→1.1: text.size 0→1, qrcode.size >10→10 / ≤1→default 4, all other fields preserved (v1.0 has no line/box/humanReadable so nothing can drop) |
| v1.0 | 2026-08-03 | Baseline: JSON Schema 2020-12; root/dataSources/three presentations (doc/receipt/label)/element types/styles/parameters. Security stance: no tenantId/storeId at the template root (server-injected identity only). | — |
