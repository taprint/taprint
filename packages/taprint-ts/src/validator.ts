// SPDX-License-Identifier: Apache-2.0
// DSL 校验与字段字典（与 C#/Dart/Java 同构）。
// Phase 1-A 决策（文档留白处）：
// - validate 的 JSON Schema 以参数注入（schema/v1.0.json 为仓库权威文件；内核不内置
//   文件路径，保证浏览器/多语言实现可注入）——validate(dsl, schema) 签名（schema 由调用方注入）；
// - validateBusiness 规则：表达式文法移交 ExpressionCompiler.compile+
//   字段绑定存在性；解析顺序为数据源 → parameters→
//   FieldRegistry（bizType = dsl.code）兜底；错误码 bad-expression / unknown-field /
//   ambiguous-field（裸路径命中多源，十轮规范裁决）。
// - DSL 2.0 cross-path 规则：schema 只管单字段形状，跨字段结构
//   正确性在此校——表头网格占位（colspan/rowspan 越界/重叠/未填满）、subtotal.values
//   与列数一一对齐、staticRows 行宽对齐、loop.each / subtable.source 必须引用 detail 源。
//   错误码：header-cell-span-mismatch / subtotal-values-length / static-row-span-mismatch /
//   loop-each-not-detail / subtable-source-not-detail。
//   conditional.when 不做静态布尔类型判定（表达式返回类型运行期才可知），渲染按 JS
//   真值规则求值（0/''/null/undefined/false/NaN 为假；计数为 0 仍需显示时写
//   when: "{{count}} !== 0"，规范裁决）。
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { ExpressionCompiler } from './expression-compiler.ts';
import {
  classifyRef,
  dataSourcesOf,
  expressionsOf,
  paramNamesOf,
  type DataSourceInfo,
} from './internal/analysis.ts';
import type { FieldDef, TemplateDSL, ValidationError, ValidationResult } from './types.ts';

const compileCache = new WeakMap<object, ValidateFunction>();

/** 单元格占位跨度（默认 1；非正整数视为 1，schema 层已校 ≥1） */
const positiveInt = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 1;

/** 一行单元格 colspan 合计 */
const spanSum = (row: unknown[]): number =>
  row.reduce<number>(
    (acc, c) => acc + positiveInt((c as Record<string, unknown> | null)?.colspan),
    0,
  );

export class DslValidator {
  /** JSON Schema 校验（draft 2020-12，schema/v1.0.json；allErrors 全量报错） */
  static validate(dsl: TemplateDSL, schema: object): ValidationResult {
    let compiled = compileCache.get(schema);
    if (!compiled) {
      compiled = new Ajv2020({ allErrors: true, allowUnionTypes: true }).compile(schema);
      compileCache.set(schema, compiled);
    }
    const ok = compiled(dsl);
    return {
      valid: !!ok,
      errors: (compiled.errors ?? []).map(DslValidator.mapError),
    };
  }

  /** 业务规则校验：表达式文法（ExpressionCompiler）+ 字段绑定存在性（数据源 → parameters → FieldRegistry 兜底） */
  static validateBusiness(
    dsl: TemplateDSL,
    fieldRegistry: typeof FieldRegistry = FieldRegistry,
  ): ValidationResult {
    const sources = dataSourcesOf(dsl);
    const params = paramNamesOf(dsl);
    const registered = new Set(fieldRegistry.lookup(dsl.code).map((f) => f.code));
    const errors: ValidationError[] = [];
    for (const occ of expressionsOf(dsl)) {
      let ast;
      try {
        ast = ExpressionCompiler.compile(occ.ref);
      } catch (e) {
        errors.push({
          path: occ.path,
          code: 'bad-expression',
          message: `表达式不合法：${occ.raw}（${(e as Error).message}）`,
        });
        continue;
      }
      for (const ref of ExpressionCompiler.extractFields(ast)) {
        const verdict = classifyRef(ref, sources, params);
        if (verdict === 'ambiguous') {
          errors.push({
            path: occ.path,
            code: 'ambiguous-field',
            message: `字段引用 ${ref} 在多个数据源中存在，须加源前缀消歧`,
          });
          continue;
        }
        if (verdict === 'unknown' && !registered.has(ref)) {
          errors.push({
            path: occ.path,
            code: 'unknown-field',
            message: `表达式引用了未定义字段：${ref}`,
          });
        }
      }
    }
    DslValidator.validateV2Shapes(dsl, sources, errors);
    return { valid: errors.length === 0, errors };
  }

  // ---------- DSL 2.0 cross-path 规则 ----------

  /** doc 呈现内递归遍历流式元素，对 table/loop/subtable 做跨字段结构校验 */
  private static validateV2Shapes(
    dsl: TemplateDSL,
    sources: DataSourceInfo[],
    errors: ValidationError[],
  ): void {
    const presentations = (dsl as Record<string, unknown>).presentations as
      Record<string, unknown> | undefined;
    const doc = presentations?.doc as Record<string, unknown> | undefined;
    if (!doc || typeof doc !== 'object') return;
    for (const section of ['header', 'body', 'footer'] as const) {
      const elems = doc[section];
      if (Array.isArray(elems)) {
        DslValidator.walkFlowElements(elems, `presentations.doc.${section}`, sources, errors);
      }
    }
  }

  private static walkFlowElements(
    elems: unknown[],
    basePath: string,
    sources: DataSourceInfo[],
    errors: ValidationError[],
  ): void {
    elems.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') return;
      const el = raw as Record<string, unknown>;
      const path = `${basePath}[${i}]`;
      if (el.type === 'table') {
        DslValidator.validateTableShape(el, path, sources, errors);
        return;
      }
      if (el.type === 'loop') {
        if (typeof el.each === 'string') {
          const src = sources.find((s) => s.name === el.each);
          if (!src || src.type !== 'detail') {
            errors.push({
              path: `${path}.each`,
              code: 'loop-each-not-detail',
              message: `loop.each "${el.each}" 必须引用 type=detail 的数据源（行集合语义）`,
            });
          }
        }
        if (Array.isArray(el.body)) {
          DslValidator.walkFlowElements(el.body, `${path}.body`, sources, errors);
        }
        return;
      }
      if (el.type === 'conditional') {
        if (Array.isArray(el.body)) {
          DslValidator.walkFlowElements(el.body, `${path}.body`, sources, errors);
        }
        if (Array.isArray(el.elseBody)) {
          DslValidator.walkFlowElements(el.elseBody, `${path}.elseBody`, sources, errors);
        }
      }
    });
  }

  /** table 跨字段结构：表头网格 / 分组小计对齐 / 自由行宽 / 主从子表数据源 */
  private static validateTableShape(
    el: Record<string, unknown>,
    path: string,
    sources: DataSourceInfo[],
    errors: ValidationError[],
  ): void {
    // 引用完整性（二轮规范裁决）：table.source 拼错不得拖到渲染期才暴露
    if (typeof el.source === 'string' && !sources.some((s) => s.name === el.source)) {
      errors.push({
        path: `${path}.source`,
        code: 'table-source-unknown',
        message: `table.source "${el.source}" 未定义于 dataSources`,
      });
    }

    const columns = Array.isArray(el.columns)
      ? (el.columns as Array<Record<string, unknown>>)
      : undefined;
    const headerRows = Array.isArray(el.headerRows) ? (el.headerRows as unknown[][]) : undefined;

    let width = columns?.length;
    if (width === undefined && headerRows && headerRows.length > 0) {
      width = spanSum(headerRows[0]);
    }

    if (headerRows && width !== undefined && width > 0) {
      // 网格占位模拟：colspan/rowspan 越界/重叠/未填满均为渲染期错位，编译期即拒
      const occupied: boolean[][] = Array.from({ length: headerRows.length }, () =>
        Array<boolean>(width!).fill(false),
      );
      headerRows.forEach((row, r) => {
        if (!Array.isArray(row)) return;
        let c = 0;
        for (const cellRaw of row) {
          while (c < width! && occupied[r][c]) c++;
          const cell = (cellRaw ?? {}) as Record<string, unknown>;
          const colspan = positiveInt(cell.colspan);
          const rowspan = positiveInt(cell.rowspan);
          const overflow = c + colspan > width! || r + rowspan > headerRows.length;
          let collide = false;
          if (!overflow) {
            for (let rr = r; rr < r + rowspan && !collide; rr++) {
              for (let cc = c; cc < c + colspan; cc++) {
                if (occupied[rr][cc]) {
                  collide = true;
                  break;
                }
              }
            }
          }
          if (overflow || collide) {
            errors.push({
              path: `${path}.headerRows[${r}]`,
              code: 'header-cell-span-mismatch',
              message: `表头单元格（colspan=${colspan}, rowspan=${rowspan}）${
                overflow ? '超出表格边界' : '与其他单元格重叠'
              }（表头网格宽 ${width} 列 × ${headerRows.length} 行）`,
            });
          } else {
            for (let rr = r; rr < r + rowspan; rr++) {
              for (let cc = c; cc < c + colspan; cc++) occupied[rr][cc] = true;
            }
          }
          c += colspan;
        }
        if (!occupied[r].every(Boolean)) {
          errors.push({
            path: `${path}.headerRows[${r}]`,
            code: 'header-cell-span-mismatch',
            message: `表头第 ${r + 1} 行未填满 ${width} 列（含上方 rowspan 占位）`,
          });
        }
      });
    }

    const groups = Array.isArray(el.groups) ? (el.groups as Array<Record<string, unknown>>) : [];
    groups.forEach((g, gi) => {
      const subtotal = g?.subtotal as Record<string, unknown> | undefined;
      const values = subtotal?.values;
      if (width !== undefined && Array.isArray(values) && values.length !== width) {
        errors.push({
          path: `${path}.groups[${gi}].subtotal.values`,
          code: 'subtotal-values-length',
          message: `分组小计 values 长度 ${values.length} ≠ 表格列数 ${width}（须逐列对齐，null 留空）`,
        });
      }
    });

    const staticRows = el.staticRows as Record<string, unknown> | undefined;
    if (staticRows && Array.isArray(staticRows.rows)) {
      const rows = staticRows.rows as unknown[][];
      rows.forEach((row, ri) => {
        if (!Array.isArray(row)) return;
        const span = spanSum(row);
        if (width !== undefined && span !== width) {
          errors.push({
            path: `${path}.staticRows.rows[${ri}]`,
            code: 'static-row-span-mismatch',
            message: `staticRows 第 ${ri + 1} 行 colspan 合计 ${span} ≠ 表格列数 ${width}`,
          });
        }
        for (const cellRaw of row) {
          const rowspan = positiveInt((cellRaw as Record<string, unknown> | null)?.rowspan);
          if (ri + rowspan > rows.length) {
            errors.push({
              path: `${path}.staticRows.rows[${ri}]`,
              code: 'static-row-span-mismatch',
              message: `staticRows 第 ${ri + 1} 行 rowspan=${rowspan} 超出 staticRows 行数 ${rows.length}`,
            });
            break;
          }
        }
      });
    }

    columns?.forEach((col, ci) => {
      DslValidator.validateSubtableSource(col, `${path}.columns[${ci}]`, sources, errors);
    });
  }

  /** column.subtable.source 若指定，必须引用 type=detail 数据源（递归嵌套子表同校） */
  private static validateSubtableSource(
    col: Record<string, unknown>,
    path: string,
    sources: DataSourceInfo[],
    errors: ValidationError[],
  ): void {
    const subtable = col?.subtable as Record<string, unknown> | undefined;
    if (!subtable || typeof subtable !== 'object') return;
    if (typeof subtable.source === 'string') {
      const src = sources.find((s) => s.name === subtable.source);
      if (!src || src.type !== 'detail') {
        errors.push({
          path: `${path}.subtable.source`,
          code: 'subtable-source-not-detail',
          message: `subtable.source "${subtable.source}" 必须引用 type=detail 的数据源（主从行展开语义）`,
        });
      }
    }
    if (Array.isArray(subtable.columns)) {
      (subtable.columns as Array<Record<string, unknown>>).forEach((c, ci) => {
        DslValidator.validateSubtableSource(c, `${path}.subtable.columns[${ci}]`, sources, errors);
      });
    }
  }

  private static mapError(e: ErrorObject): ValidationError {
    return {
      path: e.instancePath || '$',
      code: e.keyword,
      message: `${e.instancePath || '$'} ${e.message ?? ''}${
        e.params && Object.keys(e.params).length > 0 ? `（${JSON.stringify(e.params)}）` : ''
      }`.trim(),
    };
  }
}

/**
 * 字段注册表。
 * register 覆写该 bizType 的字段集；lookup 返回防御性拷贝。
 */
const registryStore = new Map<string, FieldDef[]>();

export class FieldRegistry {
  /** 注册字段（业务模块启动时调用；重复注册覆写） */
  static register(bizType: string, fields: FieldDef[]): void {
    if (!bizType) throw new TypeError('FieldRegistry.register: bizType 不能为空');
    if (!Array.isArray(fields)) throw new TypeError('FieldRegistry.register: fields 必须为数组');
    registryStore.set(
      bizType,
      fields.map((f) => ({ ...f })),
    );
  }

  /** 查询字段（设计器字段面板用）；未注册的 bizType 返回空数组 */
  static lookup(bizType: string): FieldDef[] {
    return (registryStore.get(bizType) ?? []).map((f) => ({ ...f }));
  }

  /** 清空全部注册（测试隔离 / 宿主生命周期用） */
  static clear(): void {
    registryStore.clear();
  }
}
