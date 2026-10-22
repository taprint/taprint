# L2 Coverage Matrix (frozen v1)

This matrix defines which fixture templates must carry **L2 byte digests**
(ADR-0010). Every listed cell needs at least the stated number of fixture
cases; CI emits a gap report and fails when a cell is empty. Cells marked
"—" are protocol-unsupported and need no L2 case.

Frozen at repository scaffold; expanded at the v0.1 conformance review.
ZPL column **activated at v0.2** (2026-10-22, ADR-0001 gate opened — all
four languages landed together as required).

| # | Feature × protocol                | ESC/POS | TSPL | CPCL | ZPL (v0.2) |
|---|-----------------------------------|---------|------|------|------------|
| 1 | text with font sizing             | 2       | 2    | 2    | 2          |
| 2 | text alignment                    | 2       | 2    | 2    | 2          |
| 3 | codepage / GB18030 encoding       | 2       | 2    | 2    | 1          |
| 4 | barcode CODE128                   | 1       | 1    | 1    | 1          |
| 5 | barcode EAN13                     | 1       | 1    | 1    | 1          |
| 6 | barcode human-readable toggle     | 1       | 1    | 1    | —          |
| 7 | QR code (incl. ECC level)         | 1       | 1    | 1    | 1          |
| 8 | rule / line element               | —       | 1    | 1    | 1          |
| 9 | box / rectangle element           | —       | 1    | 1    | 1          |
| 10| copies parameter                  | 1       | 1    | 1    | 1          |
| 11| feed / cut / tear behavior        | 1       | 1    | 1    | 1          |
| 12| gap / black-mark media handling   | —       | 2    | 2    | 1          |
| 13| dpi dimensioning (203 / 300)      | —       | 2    | 1    | 1          |
| 14| label size frame (SIZE/GAP order) | —       | 2    | 2    | 2          |

## Mandatory special cases (each counts as an L2 fixture)

- **Rounding midpoint:** a template whose mm→dot conversion lands exactly
  on x.5 — must round half away from zero in every language (ADR-0009).
- **Unmapped character:** text containing a character outside the GB18030
  table — must encode as U+FFFD replacement everywhere (ADR-0009).
- **Float ratio:** a proportional layout value that exercises the pinned
  fixed-point number formatting (ADR-0009).
- **Identity-function exclusion:** a template calling a host function is
  tagged in the manifest and must be **skipped** by L2 while still
  running L1 (ADR-0007).
