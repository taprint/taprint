// SPDX-License-Identifier: Apache-2.0
// taprint-preview — 位图预览引擎公共 API（M3a；ADR-0008 纯 JS 路线钉死）。
export {
  renderPng,
  renderCanvas,
  type RenderOptions,
  type RenderResult,
  type CanvasResult,
  type Dpi,
  type Presentation,
} from './render.ts';
export { FontProvider, type GlyphRun, type GlyphBox, type FontProviderOptions } from './font-provider.ts';
export { MonoCanvas, type BBox } from './canvas.ts';
export { RenderError } from './scope.ts';
export { mmToDots, ptToDots, parseMm, dotsPerMm, lengthToDots } from './length.ts';
export { drawText, drawGlyphRun, pathToContours } from './text.ts';
export { barcodeMask, resampleMask, symbologyToBcid, type InkMask } from './barcode.ts';
