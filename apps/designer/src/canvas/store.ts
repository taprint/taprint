// SPDX-License-Identifier: Apache-2.0
// 画布状态（Pinia）：DSL 为单一数据来源——画布/面板全部读写 dsl 对象
// （设计契约）
import { CURRENT_VERSION, DslMigrator, type ValidationError } from 'taprint';
import { defineStore } from 'pinia';
import { schemaOfVersion } from '../shared/dsl/schema';
import { validateTemplate } from '../shared/dsl/validation';
import type { CanvasElement, Device, PresentationLike } from './types';
import { PX_PER_MM, parseLengthMm, toMm } from './types';

export interface TemplateLike {
  schemaVersion: string;
  id: string;
  code: string;
  name: string;
  dataSources?: Array<{ name: string; type: string; schema: Record<string, unknown> }>;
  presentations: Partial<Record<Device, PresentationLike>>;
  [key: string]: unknown;
}

const DEVICES: Device[] = ['doc', 'receipt', 'label'];

interface DesignerState {
  dsl: TemplateLike | null;
  device: Device | null;
  selectedIndex: number | null;
  /** 当前挂载模板的 schema 版本（loadTemplate 后为 CURRENT_VERSION） */
  schemaVersion: string | null;
  /** 加载/迁移提示（如「已从 1.0 迁移至 2.0」或加载失败原因） */
  loadNote: string | null;
  /** 最近一次 revalidate 的校验错误（schema + 业务规则合并） */
  validationErrors: ValidationError[];
  /** 宿主下发只读（setReadOnly）：保存门禁；完整编辑锁后续 */
  readOnly: boolean;
  /** 未保存变更标记（loadTemplate 复位，编辑动作置真；SDK watch 上报 dirty 消息） */
  dirty: boolean;
}

/**
 * label 专呈现文档判定（presentations 含 label 且不含 doc）——T3 禁升版路径的
 * 触发面；doc+label 混呈现仍走迁移链（doc 语义需要 2.0 容器能力时由 migrator 处理）。
 */
function isLabelOnlyDocument(raw: unknown): boolean {
  const pres = (raw as { presentations?: Record<string, unknown> } | null)?.presentations;
  return pres != null && typeof pres === 'object' && 'label' in pres && !('doc' in pres);
}

export const useDesignerStore = defineStore('designer', {
  state: (): DesignerState => ({
    dsl: null,
    device: null,
    selectedIndex: null,
    schemaVersion: null,
    loadNote: null,
    validationErrors: [],
    readOnly: false,
    dirty: false,
  }),

  getters: {
    availableDevices(state): Device[] {
      if (!state.dsl) return [];
      return DEVICES.filter((d) => state.dsl?.presentations?.[d]);
    },
    activePresentation(state): PresentationLike | null {
      if (!state.dsl || !state.device) return null;
      return state.dsl.presentations[state.device] ?? null;
    },
    activeBody(): CanvasElement[] {
      return this.activePresentation?.body ?? [];
    },
    selectedElement(): CanvasElement | null {
      if (this.selectedIndex === null) return null;
      return this.activeBody[this.selectedIndex] ?? null;
    },
    /** 首个 detail 数据源名（表格元素默认 source） */
    firstDetailSource(state): string | undefined {
      return state.dsl?.dataSources?.find((ds) => ds.type === 'detail')?.name;
    },
    validationValid(state): boolean {
      return state.validationErrors.length === 0;
    },
  },

  actions: {
    loadDsl(dsl: TemplateLike): void {
      this.dsl = JSON.parse(JSON.stringify(dsl)) as TemplateLike;
      this.device = this.availableDevices[0] ?? null;
      this.selectedIndex = null;
      this.schemaVersion = typeof dsl.schemaVersion === 'string' ? dsl.schemaVersion : null;
      this.loadNote = null;
      this.dirty = false;
    },

    /**
     * 模板加载主入口（专项步骤 4）：detectVersion → 低于当前版本经 DslMigrator
     * 迁移（逐步门禁按步产出版本选 schema，pattern 分轨链必需）→ 挂载 → 校验。
     * 加载/迁移失败不挂载、写 loadNote；返回是否挂载成功（SDK error 上报判定用）。
     */
    loadTemplate(raw: unknown): boolean {
      try {
        const from = DslMigrator.detectVersion(raw);
        let template: TemplateLike;
        let note: string | null = null;
        if (from === CURRENT_VERSION) {
          template = JSON.parse(JSON.stringify(raw)) as TemplateLike;
        } else if (isLabelOnlyDocument(raw)) {
          // 既有规则：label 文档禁升版——入库方言模板以原文 hash 锚定
          //（T5 golden 机制），migrator 升版会改写版本声明破坏锚定。原版本挂载，
          // 校验按 detectVersion 三档路由（1.0→v1.0 双读 / 1.1→v1.1）。
          template = JSON.parse(JSON.stringify(raw)) as TemplateLike;
        } else {
          template = DslMigrator.migrate(
            raw,
            from,
            CURRENT_VERSION,
            schemaOfVersion,
          ) as unknown as TemplateLike;
          note = `已从 ${from} 迁移至 ${CURRENT_VERSION}`;
        }
        this.loadDsl(template);
        // 禁升版路径（label）保留原文版本；迁移路径产物版本= CURRENT_VERSION（二者同值）
        this.schemaVersion =
          typeof template.schemaVersion === 'string' ? template.schemaVersion : CURRENT_VERSION;
        this.loadNote = note;
        this.revalidate();
        return true;
      } catch (e) {
        this.loadNote = `模板加载失败：${(e as Error).message}`;
        this.schemaVersion = null;
        this.validationErrors = [];
        return false;
      }
    },

    /** 宿主下发只读开关（setReadOnly）：完整编辑锁触发，
     * 各编辑 action 入口 self-guard（select/addElement/removeSelected/updateSelected/
     * move/resize/updatePage），保存门禁独立保留；revalidate/prepareSave 不拦截（无副作用） */
    setReadOnly(readonly: boolean): void {
      this.readOnly = readonly;
    },

    /** 对当前 dsl 跑 schema + 业务规则校验，写 validationErrors */
    revalidate(): void {
      if (!this.dsl) {
        this.validationErrors = [];
        return;
      }
      this.validationErrors = validateTemplate(
        this.dsl as unknown as Parameters<typeof validateTemplate>[0],
      ).errors;
    },

    /** 保存链路唯一门禁（专项步骤 4；api/embed save 接线复用同一入口） */
    prepareSave(): { ok: boolean; errors: ValidationError[] } {
      this.revalidate();
      return { ok: this.validationErrors.length === 0, errors: this.validationErrors };
    },

    /** doc 页面属性合并写（watermark/nup 等；undefined 删键，与 updateSelected 同语义） */
    updatePage(patch: Record<string, unknown>): void {
      if (this.readOnly) return; // 完整编辑锁
      const pres = this.activePresentation;
      if (!pres || this.device !== 'doc') return;
      const page = (pres.page ?? { size: 'A4' }) as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete page[k];
        else page[k] = v;
      }
      pres.page = page;
      this.dirty = true;
      this.revalidate();
    },

    setDevice(device: Device): void {
      if (!this.availableDevices.includes(device)) return;
      this.device = device;
      this.selectedIndex = null;
    },

    select(index: number): void {
      if (this.readOnly) return; // 完整编辑锁
      if (index >= 0 && index < this.activeBody.length) this.selectedIndex = index;
    },

    clearSelection(): void {
      this.selectedIndex = null;
    },

    addElement(element: CanvasElement, index?: number): void {
      if (this.readOnly) return; // 完整编辑锁
      const body = this.activePresentation?.body;
      if (!body) return;
      const at = index === undefined ? body.length : Math.max(0, Math.min(index, body.length));
      body.splice(at, 0, element);
      this.selectedIndex = at;
      this.dirty = true;
      this.revalidate();
    },

    removeSelected(): void {
      if (this.readOnly) return; // 完整编辑锁
      const body = this.activePresentation?.body;
      if (!body || this.selectedIndex === null) return;
      body.splice(this.selectedIndex, 1);
      this.selectedIndex = null;
      this.dirty = true;
      this.revalidate();
    },

    updateSelected(patch: Record<string, unknown>): void {
      if (this.readOnly) return; // 完整编辑锁
      const el = this.selectedElement;
      if (!el) return;
      // 空补丁非实质变更：不置脏，避免宿主收到无意义 dirty:true 噪音
      if (Object.keys(patch).length === 0) return;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete el[k];
        else el[k] = v;
      }
      this.dirty = true;
      this.revalidate();
    },

    /** label 绝对坐标拖动（dx/dy 为像素；写回 mm）；钳制在纸面内 */
    moveLabelSelected(dxPx: number, dyPx: number): void {
      if (this.readOnly) return; // 完整编辑锁
      const el = this.selectedElement;
      if (!el || this.device !== 'label') return;
      const [maxX, maxY] = this.labelMaxXY(el);
      el.x = toMm(
        Math.min(maxX, Math.max(0, parseLengthMm(el.x as string | undefined) + dxPx / PX_PER_MM)),
      );
      el.y = toMm(
        Math.min(maxY, Math.max(0, parseLengthMm(el.y as string | undefined) + dyPx / PX_PER_MM)),
      );
      this.dirty = true;
    },

    /** label 元素缩放 */
    resizeSelected(dwPx: number, dhPx: number): void {
      if (this.readOnly) return; // 完整编辑锁
      const el = this.selectedElement;
      if (!el || this.device !== 'label') return;
      const size = (this.activePresentation?.size ?? {}) as { width?: string; height?: string };
      const maxW = Math.max(
        5,
        parseLengthMm(size.width) - parseLengthMm(el.x as string | undefined),
      );
      const maxH = Math.max(
        5,
        parseLengthMm(size.height) - parseLengthMm(el.y as string | undefined),
      );
      el.width = toMm(
        Math.min(
          maxW,
          Math.max(5, parseLengthMm(el.width as string | undefined) + dwPx / PX_PER_MM),
        ),
      );
      el.height = toMm(
        Math.min(
          maxH,
          Math.max(5, parseLengthMm(el.height as string | undefined) + dhPx / PX_PER_MM),
        ),
      );
      this.dirty = true;
    },

    /** doc/receipt 流式布局：调整元素顺序（delta=±1） */
    moveFlowSelected(delta: -1 | 1): void {
      if (this.readOnly) return; // 完整编辑锁
      const body = this.activePresentation?.body;
      const i = this.selectedIndex;
      if (!body || i === null) return;
      const j = i + delta;
      if (j < 0 || j >= body.length) return;
      [body[i], body[j]] = [body[j], body[i]];
      this.selectedIndex = j;
      this.dirty = true;
    },

    /** 元素保持在 label 纸面内的最大 x/y */
    labelMaxXY(el: CanvasElement): [number, number] {
      const size = (this.activePresentation?.size ?? {}) as { width?: string; height?: string };
      return [
        Math.max(0, parseLengthMm(size.width) - parseLengthMm(el.width as string | undefined)),
        Math.max(0, parseLengthMm(size.height) - parseLengthMm(el.height as string | undefined)),
      ];
    },
  },
});
