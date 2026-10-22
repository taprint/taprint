// SPDX-License-Identifier: Apache-2.0
// Golden L1 帧提取（TS 端口，与 Java 参照 dev.taprint.golden.GoldenFrames
// 逐规则对齐——两边漂移即比对失真，改动须双侧同步）。
//
// 规则：TSPL/CPCL 按行切帧；ESC/POS 按控制字节切帧；内容参数按原始字节
// 序列化（可见 ASCII 原样、其余 \xXX），不做 GBK 解码。
export interface Frame {
  mnemonic: string;
  params: string[];
}

function frame(mnemonic: string): Frame {
  return { mnemonic, params: [] };
}

function p(f: Frame, key: string, value: string): Frame {
  f.params.push(`${key}=${value}`);
  return f;
}

export function renderFrames(frames: Frame[]): string {
  return frames
    .map((f, i) => `${String(i + 1).padStart(3, '0')}|${f.mnemonic}|${f.params.length ? f.params.join(';') : '-'}`)
    .join('\n') + (frames.length ? '\n' : '');
}

export function escapeContent(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0x5c) out += '\\\\';
    else if (b === 0x22) out += '\\"';
    else if (b === 0x0d) out += '\\r';
    else if (b === 0x0a) out += '\\n';
    else if (b === 0x09) out += '\\t';
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

// ---- 行切分 ----

export function splitLines(payload: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  let i = 0;
  while (i < payload.length) {
    if (payload[i] === 0x0d) {
      lines.push(payload.slice(start, i));
      i += 1;
      if (i < payload.length && payload[i] === 0x0a) i += 1;
      start = i;
    } else if (payload[i] === 0x0a) {
      lines.push(payload.slice(start, i));
      i += 1;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start < payload.length) lines.push(payload.slice(start));
  return lines;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/** latin1 逆变换（帧参数原文 → 原始字节；ZPL ^FD 内容字节保真用）。 */
function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function csv(line: Uint8Array, from: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let start = from;
  let inQuote = false;
  for (let i = from; i < line.length; i++) {
    if (line[i] === 0x22 && (i === from || line[i - 1] !== 0x5c)) {
      inQuote = !inQuote;
    } else if (line[i] === 0x2c && !inQuote) {
      parts.push(line.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(line.slice(start));
  return parts;
}

const s = (b: Uint8Array): string => latin1(b).trim();
const stripMm = (v: string): string => v.replace(/\s?mm/g, '').trim();

function unquote(b: Uint8Array): string {
  const v = s(b);
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

function unquoteBytes(b: Uint8Array): Uint8Array {
  const v = s(b);
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? b.slice(1, b.length - 1) : b;
}

// ---- TSPL ----

export function tsplFrames(payload: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  for (const line of splitLines(payload)) {
    if (line.length === 0) continue;
    const text = latin1(line);
    const t = text.trim();
    const args = (from: number) => csv(line, from).map(s);
    if (t.startsWith('SIZE ')) {
      const a = args(5);
      frames.push(p(p(frame('SIZE'), 'w_mm', stripMm(a[0] ?? '')), 'h_mm', stripMm(a[1] ?? '')));
    } else if (t.startsWith('GAP ')) {
      const a = args(4);
      frames.push(p(p(frame('GAP'), 'gap_mm', stripMm(a[0] ?? '')), 'blackout_mm', stripMm(a[1] ?? '')));
    } else if (t.startsWith('BLINE ')) {
      const a = args(6);
      frames.push(p(p(frame('BLINE'), 'bline_mm', stripMm(a[0] ?? '')), 'blackout_mm', stripMm(a[1] ?? '')));
    } else if (t.startsWith('DENSITY ')) {
      frames.push(p(frame('DENSITY'), 'n', t.slice(8)));
    } else if (t.startsWith('SPEED ')) {
      frames.push(p(frame('SPEED'), 'n', t.slice(6)));
    } else if (t.startsWith('DIRECTION ')) {
      frames.push(p(frame('DIRECTION'), 'n', t.slice(10)));
    } else if (t.startsWith('SET TEAR ')) {
      frames.push(p(frame('SET_TEAR'), 'state', t.slice(9)));
    } else if (t === 'CLS') {
      frames.push(frame('CLS'));
    } else if (t === 'FORMFEED') {
      frames.push(frame('FORMFEED'));
    } else if (t.startsWith('TEXT ')) {
      const a = csv(line, 5);
      const f = frame('TEXT');
      p(p(f, 'x', s(a[0] ?? [])), 'y', s(a[1] ?? []));
      p(f, 'font', unquote(a[2] ?? []));
      p(f, 'rotation', s(a[3] ?? []));
      p(f, 'x_mul', s(a[4] ?? []));
      p(f, 'y_mul', s(a[5] ?? []));
      p(f, 'content', escapeContent(unquoteBytes(a[6] ?? [])));
      frames.push(f);
    } else if (t.startsWith('BARCODE ')) {
      const a = csv(line, 8);
      const f = frame('BARCODE');
      p(p(f, 'x', s(a[0] ?? [])), 'y', s(a[1] ?? []));
      p(f, 'type', unquote(a[2] ?? []));
      p(f, 'height', s(a[3] ?? []));
      p(f, 'human', s(a[4] ?? []));
      p(f, 'rotation', s(a[5] ?? []));
      p(f, 'narrow', s(a[6] ?? []));
      p(f, 'wide', s(a[7] ?? []));
      p(f, 'content', escapeContent(unquoteBytes(a[8] ?? [])));
      frames.push(f);
    } else if (t.startsWith('QRCODE ')) {
      // 两种合法形态：8 段（model 复合 "M2"、无 mask）/ 9 段（model+mask 分立）
      const a = csv(line, 7);
      const hasMask = a.length > 8;
      const f = frame('QRCODE');
      p(p(f, 'x', s(a[0] ?? [])), 'y', s(a[1] ?? []));
      p(f, 'ecc', s(a[2] ?? []));
      p(f, 'cell', s(a[3] ?? []));
      p(f, 'mode', s(a[4] ?? []));
      p(f, 'rotation', s(a[5] ?? []));
      p(f, 'model', s(a[6] ?? []));
      p(f, 'mask', hasMask ? s(a[7]) : '-');
      p(f, 'content', escapeContent(unquoteBytes(hasMask ? a[8] : (a[7] ?? []))));
      frames.push(f);
    } else if (t.startsWith('LINE ')) {
      const a = args(5);
      const f = frame('LINE');
      p(p(p(p(p(f, 'x1', a[0]), 'y1', a[1]), 'x2', a[2]), 'y2', a[3]), 'thickness', a[4]);
      frames.push(f);
    } else if (t.startsWith('BOX ')) {
      const a = args(4);
      const f = frame('BOX');
      p(p(p(p(f, 'x1', a[0]), 'y1', a[1]), 'x2', a[2]), 'y2', a[3]);
      f.params.push(`thickness=${a[4] ?? '-'}`);
      frames.push(f);
    } else if (t.startsWith('BAR ')) {
      const a = args(4);
      const f = frame('BAR');
      p(p(p(f, 'x', a[0]), 'y', a[1]), 'width', a[2]);
      f.params.push(`height=${a[3] ?? '-'}`);
      frames.push(f);
    } else if (t.startsWith('PRINT ')) {
      frames.push(p(frame('PRINT'), 'copies', t.slice(6)));
    } else if (t.startsWith('BITMAP ')) {
      frames.push(p(frame('BITMAP'), 'raw', escapeContent(line)));
    } else {
      frames.push(p(frame('UNKNOWN'), 'raw', escapeContent(line)));
    }
  }
  return frames;
}

// ---- CPCL ----

export function cpclFrames(payload: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  for (const line of splitLines(payload)) {
    if (line.length === 0) continue;
    const text = latin1(line).trim();
    const tok = text.split(/ +/);
    const tailFrom = (count: number): Uint8Array => {
      // 内容前缀长度：各结构词 + 其后分隔空格（内容紧随最后一个空格之后）
      let len = 0;
      for (let i = 0; i < count; i++) len += tok[i].length + 1;
      return line.slice(len);
    };
    if (text.startsWith('!')) {
      const f = frame('HEADER');
      p(p(p(p(p(f, 'offset', tok[1]), 'horz', tok[2]), 'vert', tok[3]), 'height', tok[4]), 'qty', tok[5]);
      frames.push(f);
    } else if (text.startsWith('BARCODE QR ')) {
      const f = frame('QR_BEGIN');
      p(p(p(p(f, 'x', tok[2]), 'y', tok[3]), 'sel', tok[4]), 'model', tok[5]);
      f.params.push(`unit=${tok[7]}`);
      frames.push(f);
    } else if (text.startsWith('M0A,')) {
      frames.push(
        p(p(frame('QR_DATA'), 'prefix', 'M0A'), 'content', escapeContent(line.slice(4))),
      );
    } else if (text === 'ENDQR') {
      frames.push(frame('QR_END'));
    } else if (text.startsWith('TEXT ')) {
      const f = frame('TEXT');
      p(p(p(p(f, 'font', tok[1]), 'size', tok[2]), 'x', tok[3]), 'y', tok[4]);
      f.params.push(`content=${escapeContent(tailFrom(5))}`);
      frames.push(f);
    } else if (text.startsWith('BARCODE-TEXT ')) {
      const f = frame('BARCODE_TEXT');
      p(p(p(p(f, 'font', tok[1]), 'size', tok[2]), 'x', tok[3]), 'y', tok[4]);
      f.params.push(`content=${escapeContent(tailFrom(5))}`);
      frames.push(f);
    } else if (text.startsWith('BARCODE ')) {
      const f = frame('BARCODE');
      p(p(p(p(p(f, 'type', tok[1]), 'width', tok[2]), 'ratio', tok[3]), 'height', tok[4]), 'x', tok[5]);
      f.params.push(`y=${tok[6]}`);
      f.params.push(`content=${escapeContent(tailFrom(7))}`);
      frames.push(f);
    } else if (text.startsWith('LINE ')) {
      const f = frame('LINE');
      p(p(p(p(p(f, 'x1', tok[1]), 'y1', tok[2]), 'x2', tok[3]), 'y2', tok[4]), 'thickness', tok[5]);
      frames.push(f);
    } else if (text.startsWith('BOX ')) {
      const f = frame('BOX');
      p(p(p(p(p(f, 'x1', tok[1]), 'y1', tok[2]), 'x2', tok[3]), 'y2', tok[4]), 'thickness', tok[5]);
      frames.push(f);
    } else if (text.startsWith('EG ')) {
      frames.push(p(frame('EG'), 'raw_len', String(line.length)));
    } else if (text === 'FORM') {
      frames.push(frame('FORM'));
    } else if (text === 'PRINT') {
      frames.push(frame('PRINT'));
    } else {
      frames.push(p(frame('UNKNOWN'), 'raw', escapeContent(line)));
    }
  }
  return frames;
}

// ---- ZPL ----

// ZPL 帧提取：按 ^ 指令边界切分（ZPL 非行式协议，指令 = ^ + 两字符码 +
// 参数段，参数段止于下一个 ^）——与 Java 参照 GoldenFrames.zpl 逐规则对齐。
export function zplFrames(payload: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  const text = latin1(payload);
  const at = (args: string[], i: number): string => (i < args.length ? args[i] : '-');
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '^' || i + 3 > text.length ||
        !/[A-Z]/.test(text[i + 1]) || !/[A-Z0-9]/.test(text[i + 2])) {
      i += 1;
      continue;
    }
    const code = text.slice(i + 1, i + 3);
    let end = text.indexOf('^', i + 3);
    if (end < 0) end = text.length;
    const params = text.slice(i + 3, end);
    i = end;
    const args = params.split(',');
    switch (code) {
      case 'XA':
        frames.push(frame('FRAME_START'));
        break;
      case 'LH':
        frames.push(p(p(frame('LABEL_HOME'), 'x', at(args, 0)), 'y', at(args, 1)));
        break;
      case 'PW':
        frames.push(p(frame('PRINT_WIDTH'), 'dots', params));
        break;
      case 'LL':
        frames.push(p(frame('LABEL_LENGTH'), 'dots', params));
        break;
      case 'FO':
        frames.push(p(p(frame('FIELD_ORIGIN'), 'x', at(args, 0)), 'y', at(args, 1)));
        break;
      case 'A0':
        frames.push(p(p(p(frame('FONT'), 'rotation', at(args, 0)), 'h', at(args, 1)), 'w', at(args, 2)));
        break;
      case 'BY':
        frames.push(p(p(p(frame('BARCODE_DEFAULT'), 'narrow', at(args, 0)), 'ratio', at(args, 1)), 'height', at(args, 2)));
        break;
      case 'BC':
      case 'BE':
      case 'B3':
      case 'B2':
      case 'BU': {
        const f = frame('BARCODE_SYM');
        p(p(f, 'head', code), 'args', params);
        frames.push(f);
        break;
      }
      case 'BQ':
        frames.push(p(p(p(frame('QR_BEGIN'), 'rotation', at(args, 0)), 'model', at(args, 1)), 'size', at(args, 2)));
        break;
      case 'FD':
        frames.push(p(frame('FIELD_DATA'), 'content', escapeContent(latin1Bytes(params))));
        break;
      case 'FS':
        frames.push(frame('FIELD_SEP'));
        break;
      case 'GB':
        frames.push(p(p(p(frame('GRAPHIC_BOX'), 'w', at(args, 0)), 'h', at(args, 1)), 't', at(args, 2)));
        break;
      case 'PQ':
        frames.push(p(frame('PRINT_QTY'), 'n', params));
        break;
      case 'XZ':
        frames.push(frame('FRAME_END'));
        break;
      default:
        frames.push(p(frame('UNKNOWN'), 'raw', escapeContent(latin1Bytes(`^${code}${params}`))));
        break;
    }
  }
  return frames;
}

// ---- ESC/POS ----

export function escposFrames(payload: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  let text: number[] = [];
  const flush = () => {
    if (text.length > 0) {
      frames.push(p(frame('TEXT'), 'content', escapeContent(Uint8Array.from(text))));
      text = [];
    }
  };
  let i = 0;
  while (i < payload.length) {
    const b = payload[i];
    if (b === 0x0a) {
      flush();
      frames.push(frame('LF'));
      i += 1;
    } else if (b === 0x1b) {
      i = escCommand(payload, i, frames, flush);
    } else if (b === 0x1c || b === 0x1d) {
      i = gsCommand(payload, i, frames, flush);
    } else {
      text.push(b);
      i += 1;
    }
  }
  flush();
  return frames;
}

function escCommand(
  payload: Uint8Array,
  i: number,
  frames: Frame[],
  flush: () => void,
): number {
  const cmd = payload[i + 1];
  if (cmd === 0x40) {
    flush();
    frames.push(frame('INIT'));
    return i + 2;
  }
  if (cmd === 0x61) {
    flush();
    frames.push(p(frame('ALIGN'), 'n', String(payload[i + 2])));
    return i + 3;
  }
  if (cmd === 0x45) {
    flush();
    frames.push(p(frame('BOLD'), 'on', String(payload[i + 2])));
    return i + 3;
  }
  if (cmd === 0x64) {
    flush();
    frames.push(p(frame('FEED'), 'lines', String(payload[i + 2])));
    return i + 3;
  }
  if (cmd === 0x70) {
    flush();
    const f = frame('DRAWER');
    p(p(f, 'm', String(payload[i + 2])), 't1', String(payload[i + 3]));
    f.params.push(`t2=${String(payload[i + 4])}`);
    frames.push(f);
    return i + 5;
  }
  flush();
  frames.push(p(frame('ESC_OTHER'), 'raw', escapeContent(payload.slice(i, i + 4))));
  return i + 2;
}

function gsCommand(
  payload: Uint8Array,
  i: number,
  frames: Frame[],
  flush: () => void,
): number {
  const lead = payload[i];
  const cmd = payload[i + 1];
  if (lead === 0x1c && cmd === 0x26) {
    flush();
    frames.push(frame('CN_ON'));
    return i + 2;
  }
  if (lead !== 0x1d) {
    flush();
    frames.push(p(frame('ESC_OTHER'), 'raw', escapeContent(payload.slice(i, i + 4))));
    return i + 2;
  }
  if (cmd === 0x21) {
    flush();
    frames.push(p(frame('FONT_SIZE'), 'n', String(payload[i + 2])));
    return i + 3;
  }
  if (cmd === 0x48) {
    flush();
    frames.push(p(frame('BAR_HRI'), 'pos', String(payload[i + 2])));
    return i + 3;
  }
  if (cmd === 0x68) {
    flush();
    frames.push(p(frame('BAR_HEIGHT'), 'dots', String(payload[i + 2])));
    return i + 3;
  }
  if (cmd === 0x77) {
    flush();
    frames.push(p(frame('BAR_WIDTH'), 'dots', String(payload[i + 2])));
    return i + 3;
  }
  if (cmd === 0x56) {
    flush();
    frames.push(p(frame('CUT'), 'mode', String(payload[i + 2])));
    return i + 3;
  }
  if (cmd === 0x6b) {
    flush();
    const m = payload[i + 2];
    const n = payload[i + 3];
    const f = p(p(frame('BAR_PRINT'), 'm', String(m)), 'len', String(n));
    f.params.push(`content=${escapeContent(payload.slice(i + 4, i + 4 + n))}`);
    frames.push(f);
    return i + 4 + n;
  }
  if (cmd === 0x28 && payload[i + 2] === 0x6b) {
    return gsParenK(payload, i, frames, flush);
  }
  flush();
  frames.push(p(frame('GS_OTHER'), 'raw', escapeContent(payload.slice(i, i + 4))));
  return cmd === 0x28 ? i + 4 : i + 3;
}

function gsParenK(
  payload: Uint8Array,
  i: number,
  frames: Frame[],
  flush: () => void,
): number {
  const pl = payload[i + 3];
  const ph = payload[i + 4];
  const len = (ph << 8) | pl;
  const fn = payload[i + 6];
  flush();
  if (fn === 0x41) {
    frames.push(p(frame('QR_MODEL'), 'n', String(payload[i + 7])));
  } else if (fn === 0x43) {
    frames.push(p(frame('QR_SIZE'), 'n', String(payload[i + 7])));
  } else if (fn === 0x45) {
    frames.push(p(frame('QR_ECC'), 'n', String(payload[i + 7])));
  } else if (fn === 0x50) {
    frames.push(
      p(p(frame('QR_DATA'), 'len', String(len - 3)), 'content', escapeContent(payload.slice(i + 8, i + 5 + len))),
    );
  } else if (fn === 0x51) {
    frames.push(frame('QR_PRINT'));
  } else {
    frames.push(p(frame('GS_OTHER'), 'fn', String(fn)));
  }
  return i + 5 + len;
}
