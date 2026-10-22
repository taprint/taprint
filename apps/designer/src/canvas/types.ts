// SPDX-License-Identifier: Apache-2.0
// 画布元素模型（与 schema/v1.0.json 元素定义对齐；完整字段以 schema 为准）

export type Device = 'doc' | 'receipt' | 'label';

export interface ElementStyle {
  fontFamily?: string;
  fontSize?: number | string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string | null;
  backgroundColor?: string | null;
  align?: 'left' | 'center' | 'right';
  [key: string]: unknown;
}

export interface TableColumn {
  header: string;
  field: string;
  width?: string;
  align?: 'left' | 'center' | 'right';
  format?: string;
  /** DSL 2.0：主从表列级子表（镜像 tableColumn.subtable） */
  subtable?: SubtableV2;
}

export interface TableSummary {
  label: string;
  value: string;
  align?: 'left' | 'center' | 'right';
}

// ---------- DSL 2.0 视图镜像类型（镜像 schema/v2.0.json definitions；完整字段以 schema 为准） ----------

/** 镜像 definitions.headerCell（多级/斜线表头单元格） */
export interface HeaderCellV2 {
  text: string;
  colspan?: number;
  rowspan?: number;
  diagonal?: 'ltr' | 'rtl' | 'both';
  /** 必须伴随 diagonal（schema if/then 耦合） */
  diagonalLabels?: { tl?: string; tr?: string; bl?: string; br?: string };
  align?: 'left' | 'center' | 'right';
  style?: ElementStyle;
}

/** 镜像 definitions.tableCell（staticRows 自由行单元格） */
export interface TableCellV2 {
  value?: string;
  colspan?: number;
  rowspan?: number;
  align?: 'left' | 'center' | 'right';
  style?: ElementStyle;
}

/** 镜像 definitions.tableGroup（分组小计；subtotal.values 与列数一一对齐，null 留空） */
export interface TableGroupV2 {
  field: string;
  header?: string;
  subtotal?: { label?: string; values: Array<string | null> };
}

/** 镜像 definitions.staticRows（自由合并行区） */
export interface StaticRowsV2 {
  position?: 'before' | 'after';
  rows: TableCellV2[][];
}

/** 镜像 tableColumn.subtable（主从表列级子表） */
export interface SubtableV2 {
  source?: string;
  columns: TableColumn[];
}

/** 镜像 page.watermark（text/image，if/then 必填耦合） */
export interface WatermarkV2 {
  type: 'text' | 'image';
  text?: string;
  src?: string;
  opacity?: number;
  angle?: number;
  tile?: boolean;
  style?: ElementStyle;
}

/** 镜像 page.nup（一页多单） */
export interface NupV2 {
  cols: number;
  rows: number;
  gap?: string;
}

/** doc page 定义（v2 增 watermark/nup） */
export interface PageDefV2 {
  size?: string;
  orientation?: string;
  margin?: unknown;
  watermark?: WatermarkV2;
  nup?: NupV2;
  [key: string]: unknown;
}

/** DSL 呈现中的单个元素（type 判别；可选字段按 schema 元素类型取用） */
export interface CanvasElement {
  type: string;
  content?: string;
  src?: string;
  symbology?: string;
  size?: number;
  height?: string;
  width?: string;
  x?: string;
  y?: string;
  source?: string;
  /** table：列定义数组；kvtable：列数（schema 同名字段，按 type 判别） */
  columns?: TableColumn[] | number;
  summary?: TableSummary[];
  rows?: string[][][];
  compact?: boolean;
  partial?: boolean;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  /** line/box：线宽 dot（schema v1.1，1-32；缺省 2） */
  thickness?: number;
  /** box：圆角半径（schema v1.1 可选；TSPL 无原生命令=打印降级直角） */
  radius?: string;
  /** text（label v1.1）：字体角色（auto/cjk/latin；fontRole 优先于 font） */
  fontRole?: 'auto' | 'cjk' | 'latin';
  /** barcode（label v1.1）：人读号（缺省留空，模板显式写值） */
  humanReadable?: boolean;
  font?: string;
  style?: ElementStyle;
  align?: 'left' | 'center' | 'right';
  // ---- DSL 2.0（table 单元格模型 / loop/conditional 容器） ----
  headerRows?: HeaderCellV2[][];
  layout?: { repeatHeaderOnPageBreak?: boolean };
  groups?: TableGroupV2[];
  staticRows?: StaticRowsV2;
  /** loop：遍历的 detail 数据源名 */
  each?: string;
  /** conditional：JS 真值规则求值（0/''/null/undefined/false/NaN 为假） */
  when?: string;
  /** loop/conditional 子元素 */
  body?: CanvasElement[];
  elseBody?: CanvasElement[];
  [key: string]: unknown;
}

export interface PresentationLike {
  body: CanvasElement[];
  [key: string]: unknown;
}

/** 像素/毫米换算（96dpi 屏幕基准） */
export const PX_PER_MM = 96 / 25.4;

/** doc 页面缺省页边距 */
export const DEFAULT_PAGE_MARGIN_MM = 10;

// schema length 允许 mm/cm/pt/px（% 无几何参照物，返回 0）；1pt = 25.4/72 mm，1px = 25.4/96 mm
const MM_PER_UNIT: Record<string, number> = {
  mm: 1,
  cm: 10,
  pt: 25.4 / 72,
  px: 25.4 / 96,
};

export function parseLengthMm(value: string | undefined): number {
  if (!value) return 0;
  const m = /^(\d+(?:\.\d+)?)(mm|cm|pt|px)$/.exec(value);
  if (!m) return 0;
  return Number(m[1]) * MM_PER_UNIT[m[2]];
}

export function toMm(mm: number): string {
  return `${Number(mm.toFixed(2))}mm`;
}
