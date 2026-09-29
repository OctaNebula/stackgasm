// A tiny x86-64 (AT&T syntax) simulator built for teaching.
//
// * Memory is byte-granular. A byte is a number 0..255, `null` (unknown garbage),
//   or a piece of a symbolic value `{ s: symId, i: 0..7 }` (return addresses, old %rbp, &labels).
// * Every instruction produces a list of human-readable micro-steps (`steps`) using a tiny markup:
//   `code`, **bold** and {{dim note}}.
// * `ctx.quirk` makes the executor deliberately apply a *wrong* mental model of the instruction.
//   The game runs those to recognise the mistake a player made and explain it.

const SUBDIG = '₀₁₂₃₄₅₆₇₈₉';
export const subscript = (n) => String(n).replace(/\d/g, (d) => SUBDIG[d]);

export class SimError extends Error {}

// ───────────────────────────── registers ─────────────────────────────

export const REGS64 = ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
export const REG = {};
for (const r of REGS64) REG[r] = { base: r, size: 8, off: 0 };
const LEGACY = {
  rax: ['eax', 'ax', 'al', 'ah'], rbx: ['ebx', 'bx', 'bl', 'bh'], rcx: ['ecx', 'cx', 'cl', 'ch'], rdx: ['edx', 'dx', 'dl', 'dh'],
  rsi: ['esi', 'si', 'sil'], rdi: ['edi', 'di', 'dil'], rbp: ['ebp', 'bp', 'bpl'], rsp: ['esp', 'sp', 'spl'],
};
for (const [r, [d, w, b, h]] of Object.entries(LEGACY)) {
  REG[d] = { base: r, size: 4, off: 0 };
  REG[w] = { base: r, size: 2, off: 0 };
  REG[b] = { base: r, size: 1, off: 0 };
  if (h) REG[h] = { base: r, size: 1, off: 1 };
}
for (let i = 8; i <= 15; i++) {
  REG[`r${i}d`] = { base: `r${i}`, size: 4, off: 0 };
  REG[`r${i}w`] = { base: `r${i}`, size: 2, off: 0 };
  REG[`r${i}b`] = { base: `r${i}`, size: 1, off: 0 };
}

// ───────────────────────────── byte model ─────────────────────────────

export const isNum = (b) => typeof b === 'number';
export const unk = (n = 8) => Array(n).fill(null);
export const symBytes = (s) => Array.from({ length: 8 }, (_, i) => ({ s, i }));

export function fromBig(v, n = 8) {
  let u = BigInt.asUintN(n * 8, BigInt(v));
  const out = [];
  for (let i = 0; i < n; i++) { out.push(Number(u & 0xffn)); u >>= 8n; }
  return out;
}

/** Little-endian bytes → BigInt (signed by default). null if any byte isn't a known number. */
export function toBig(bytes, signed = true) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    const b = bytes[i];
    if (!isNum(b)) return null;
    v = (v << 8n) | BigInt(b);
  }
  return signed ? BigInt.asIntN(bytes.length * 8, v) : v;
}

export function byteEq(a, b) {
  if (a === b) return true;
  return !!(a && b && typeof a === 'object' && typeof b === 'object' && a.s === b.s && a.i === b.i);
}
export function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!byteEq(a[i], b[i])) return false;
  return true;
}

/** num | unk | sym | mixed */
export function classify(bytes) {
  if (bytes.every(isNum)) return { kind: 'num', v: toBig(bytes) };
  if (bytes.every((b) => b === null)) return { kind: 'unk' };
  const b0 = bytes[0];
  if (b0 && typeof b0 === 'object' && bytes.length === 8 && bytes.every((b, i) => b && typeof b === 'object' && b.s === b0.s && b.i === i)) {
    return { kind: 'sym', s: b0.s };
  }
  return { kind: 'mixed' };
}

export function symLabel(id, syms) {
  return (syms && syms[id] && syms[id].label) || id;
}

export function fmtNum(v, hex = false) {
  if (!hex) return v.toString();
  const u = v < 0n ? BigInt.asUintN(64, v) : v;
  return '0x' + u.toString(16);
}

export function fmtByte(b, hex = false) {
  if (b === null) return '?';
  if (typeof b === 'object') return '∗';
  return hex ? b.toString(16).padStart(2, '0') : String(b);
}

/** Plain-text rendering of an 8-byte (or n-byte) value. Mixed values render MSB … LSB like the exam: "? ? ? ? ? ? ? 32". */
export function valText(bytes, syms, hex = false) {
  const c = classify(bytes);
  if (c.kind === 'num') return fmtNum(c.v, hex);
  if (c.kind === 'unk') return '?';
  if (c.kind === 'sym') return symLabel(c.s, syms);
  return '[' + bytes.slice().reverse().map((b) => fmtByte(b, hex)).join(' ') + ']';
}

// ───────────────────────────── machine ─────────────────────────────

export function machine() {
  return { regs: {}, mem: new Map(), flags: null, cmp: null };
}
export function clone(m) {
  const regs = {};
  for (const k in m.regs) regs[k] = m.regs[k].slice();
  return { regs, mem: new Map(m.mem), flags: m.flags, cmp: m.cmp };
}
export function getReg(m, name) {
  const d = REG[name];
  const full = m.regs[d.base] || unk();
  return full.slice(d.off, d.off + d.size);
}
/** Write a (sub)register with real x86-64 semantics: 32-bit writes zero the upper half, 8/16-bit writes merge. */
export function setReg(m, name, bytes, { zext = true, zextSmall = false } = {}) {
  const d = REG[name];
  const full = (m.regs[d.base] || unk()).slice();
  for (let i = 0; i < d.size; i++) full[d.off + i] = bytes[i];
  if ((d.size === 4 && zext) || (d.size < 4 && zextSmall)) for (let i = d.off + d.size; i < 8; i++) full[i] = 0;
  m.regs[d.base] = full;
}
export function readMem(m, addr, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = m.mem.get(addr + i);
    out.push(v === undefined ? null : v);
  }
  return out;
}
export function writeMem(m, addr, bytes) {
  bytes.forEach((b, i) => {
    if (b === null) m.mem.delete(addr + i);
    else m.mem.set(addr + i, b);
  });
}
export function regNum(m, name) {
  const v = toBig(getReg(m, name));
  return v === null ? null : Number(v);
}
function regAddr(m, name) {
  const v = regNum(m, name);
  if (v === null) throw new SimError(`%${name} does not hold a known address`);
  return v;
}
function setRegNum(m, name, v) { setReg(m, name, fromBig(BigInt(v))); }

// ───────────────────────────── parser ─────────────────────────────

const BASE_OPS = new Set(['push', 'pop', 'mov', 'lea', 'add', 'sub', 'inc', 'dec', 'neg', 'not', 'and', 'or', 'xor',
  'shl', 'sal', 'shr', 'sar', 'imul', 'mul', 'div', 'idiv', 'cmp', 'test', 'call', 'ret', 'leave', 'nop', 'jmp']);
export const JCC = {
  je: 'e', jz: 'e', jne: 'ne', jnz: 'ne', jl: 'l', jnge: 'l', jle: 'le', jng: 'le', jg: 'g', jnle: 'g', jge: 'ge', jnl: 'ge',
  jb: 'b', jnae: 'b', jc: 'b', jbe: 'be', jna: 'be', ja: 'a', jnbe: 'a', jae: 'ae', jnb: 'ae', jnc: 'ae', js: 's', jns: 'ns',
};
const SUFFIX = { b: 1, w: 2, l: 4, q: 8 };
const SHIFTS = new Set(['shl', 'sal', 'shr', 'sar']);
const SIZED_OPS = new Set(['mov', 'add', 'sub', 'and', 'or', 'xor', 'cmp', 'test', 'inc', 'dec', 'neg', 'not', 'shl', 'sal', 'shr', 'sar', 'imul', 'mul', 'div', 'idiv']);

function parseNum(s) {
  s = s.trim();
  let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1).trim(); } else if (s.startsWith('+')) s = s.slice(1).trim();
  let v;
  if (/^0x[0-9a-f]+$/i.test(s) || /^0b[01]+$/i.test(s) || /^\d+$/.test(s)) v = BigInt(s);
  else return null;
  return neg ? -v : v;
}

function parseOperand(s) {
  s = s.trim();
  if (s.startsWith('$')) {
    const n = parseNum(s.slice(1));
    if (n !== null) return { t: 'imm', v: n, text: s };
    return { t: 'imm', sym: s.slice(1).trim(), text: s };
  }
  if (s.startsWith('%')) {
    const name = s.slice(1).toLowerCase();
    const d = REG[name];
    if (!d) throw new SimError(`Unknown register ${s}`);
    return { t: 'reg', name, base: d.base, size: d.size, text: s };
  }
  const pm = s.match(/^([^()]*)\(([^)]*)\)$/);
  if (pm) {
    const dispS = pm[1].trim();
    const disp = dispS ? parseNum(dispS) : 0n;
    if (disp === null) throw new SimError(`Bad displacement in ${s}`);
    const parts = pm[2].split(',').map((x) => x.trim());
    const reg = (p) => {
      if (!p) return null;
      const o = parseOperand(p);
      if (o.t !== 'reg' || o.size !== 8) throw new SimError(`Bad register in ${s}`);
      return o.name;
    };
    const scale = parts[2] ? Number(parts[2]) : 1;
    return { t: 'mem', disp: Number(disp), base: reg(parts[0]), index: reg(parts[1]), scale, text: s.replace(/\s+/g, ' ') };
  }
  const n = parseNum(s);
  if (n !== null) return { t: 'mem', disp: Number(n), base: null, index: null, scale: 1, text: s };
  return { t: 'label', name: s, text: s };
}

function splitOperands(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Parse one line of AT&T assembly. Returns null for blank / directive-only lines. */
export function parse(line) {
  let text = line;
  let comment = '';
  const hash = text.indexOf('#');
  if (hash >= 0) { comment = text.slice(hash + 1).trim(); text = text.slice(0, hash); }
  text = text.trim();
  let label = null;
  const lm = text.match(/^([A-Za-z_.][\w.]*):\s*(.*)$/);
  if (lm) { label = lm[1]; text = lm[2].trim(); }
  if (!text || text.startsWith('.')) return { label, empty: true, comment, text };
  const sp = text.search(/\s/);
  const mnem = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
  const rest = sp < 0 ? '' : text.slice(sp + 1).trim();
  let op, size = null, cond = null, ext = null;
  const mx = mnem.match(/^mov([sz])([bwl])([wlq])$/);
  if (mx) { op = 'movx'; ext = { signed: mx[1] === 's', from: SUFFIX[mx[2]] }; size = SUFFIX[mx[3]]; }
  else if (JCC[mnem]) { op = 'jcc'; cond = JCC[mnem]; }
  else if (BASE_OPS.has(mnem)) op = mnem;
  else if (mnem === 'cqto' || mnem === 'cqo') op = 'cqto';
  else if (BASE_OPS.has(mnem.slice(0, -1)) && SUFFIX[mnem.slice(-1)]) { op = mnem.slice(0, -1); size = SUFFIX[mnem.slice(-1)]; }
  else throw new SimError(`Unknown instruction "${mnem}"`);
  const operands = splitOperands(rest).map(parseOperand);
  if (op !== 'movx') {
    const isShift = SHIFTS.has(op) && operands.length === 2;
    const regs = (isShift ? [operands[1]] : operands).filter((o) => o.t === 'reg');
    if (size === null) {
      if (regs.length) size = regs[0].size;
      else if (SIZED_OPS.has(op) && operands.some((o) => o.t === 'mem')) throw new SimError(`ambiguous operand size in "${text}" — add a suffix (b/w/l/q)`);
      else size = 8;
    }
    if (SIZED_OPS.has(op) || op === 'push' || op === 'pop') {
      for (const r of regs) if (r.size !== size) throw new SimError(`operand size mismatch in "${text}": %${r.name} is ${r.size * 8}-bit`);
    }
    if ((op === 'push' || op === 'pop') && size !== 8) throw new SimError('only 64-bit push/pop (pushq/popq) are supported');
    if (operands.some((o) => o.t === 'imm' && o.sym) && size !== 8) throw new SimError('a label address ($label) needs a 64-bit destination');
  }
  const pretty = operands.length ? `${mnem} ${operands.map((o) => o.text).join(', ')}` : mnem;
  return { op, mnem, size, cond, ext, operands, label, comment, text: pretty };
}

// ───────────────────────────── helpers for explanations ─────────────────────────────

const neg = (v) => (v < 0 ? `(−${-v})` : `${v}`);
const SIZE_WORD = { 1: '1 byte', 2: '2 bytes', 4: '4 bytes', 8: '8 bytes' };
const SUFFIX_OF = { 1: 'b', 2: 'w', 4: 'l', 8: 'q' };

/** Effective address of a memory operand, with an explanation line pushed to `steps`. */
function effAddr(m, op, steps, what = 'address', allowNeg = false) {
  let total = BigInt(op.disp);
  let s1 = '', s2 = '';
  if (op.base) {
    const v = BigInt(regAddr(m, op.base));
    total += v;
    s1 = `%${op.base}`; s2 = `${v}`;
  }
  if (op.index) {
    const iv = toBig(getReg(m, op.index));
    if (iv === null) throw new SimError(`%${op.index} is unknown`);
    total += iv * BigInt(op.scale);
    s1 += (s1 ? ' + ' : '') + `%${op.index}×${op.scale}`;
    s2 += (s2 ? ' + ' : '') + `${neg(iv)}×${op.scale}`;
  }
  if (op.disp || !s1) {
    const d = op.disp;
    if (s1) { const t = d < 0 ? ` − ${-d}` : ` + ${d}`; s1 += t; s2 += t; }
    else { s1 = `${d}`; s2 = s1; }
  }
  const addr = Number(total);
  if (steps) {
    if (s2 === String(addr)) steps.push(`${what} of \`${op.text}\` = \`${s1}\` = **${addr}**`);
    else steps.push(`${what} of \`${op.text}\` = \`${s1}\` = ${s2} = **${addr}**`);
  }
  if (addr < 0 && !allowNeg) throw new SimError('negative address');
  return addr;
}

function labelSym(name) { return '&' + name; }

/** Read an operand as `size` bytes. Pushes an address step for memory operands. */
function readOp(m, op, size, steps) {
  if (op.t === 'imm') {
    if (op.sym) return symBytes(labelSym(op.sym));
    return fromBig(op.v, size);
  }
  if (op.t === 'reg') return getReg(m, op.name);
  if (op.t === 'mem') {
    const a = effAddr(m, op, steps);
    return readMem(m, a, size);
  }
  throw new SimError(`Can't read ${op.text}`);
}

/** Pretty name of an operand inside explanations, e.g. `%rdi`, `$5`, `M[376]`. */
function opName(m, op) {
  if (op.t === 'imm') return `\`${op.text}\``;
  if (op.t === 'reg') return `\`%${op.name}\``;
  if (op.t === 'mem') {
    try { return `\`M[${effAddr(m, op, null)}]\``; } catch { return `\`${op.text}\``; }
  }
  return `\`${op.text}\``;
}

function slotNote(m, addr, size, syms) {
  const slot = Math.floor(addr / 8) * 8;
  const bytes = readMem(m, slot, 8);
  return `{{only ${SIZE_WORD[size]} written (suffix \`${SUFFIX_OF[size]}\`) — the other ${8 - size} bytes of the slot at ${slot} keep their old value. Little-endian: offset +0 is the least significant byte. Slot ${slot} now reads}} **${valText(bytes, syms)}**`;
}

// ───────────────────────────── arithmetic ─────────────────────────────

function alu(kind, xB, yB, size) {
  const bits = size * 8;
  const B = BigInt(bits);
  const xu = toBig(xB, false), yu = toBig(yB, false);
  if (xu === null || yu === null) return { bytes: unk(size), flags: null, unknown: true };
  const top = (v) => (v >> (B - 1n)) & 1n;
  const xs = BigInt.asIntN(bits, xu), ys = BigInt.asIntN(bits, yu);
  let r, CF = false, OF = false;
  switch (kind) {
    case 'add': { const t = xu + yu; CF = t >= (1n << B); r = BigInt.asUintN(bits, t); OF = top(xu) === top(yu) && top(r) !== top(xu); break; }
    case 'sub': { r = BigInt.asUintN(bits, xu - yu); CF = xu < yu; OF = top(xu) !== top(yu) && top(r) !== top(xu); break; }
    case 'and': r = xu & yu; break;
    case 'or': r = xu | yu; break;
    case 'xor': r = xu ^ yu; break;
    case 'imul': { const p = xs * ys; r = BigInt.asUintN(bits, p); CF = OF = p !== BigInt.asIntN(bits, r); break; }
    default: throw new SimError('alu ' + kind);
  }
  return { bytes: fromBig(r, size), flags: { ZF: r === 0n, SF: top(r) === 1n, CF, OF }, value: BigInt.asIntN(bits, r) };
}

const SYM_OF = { add: '+', sub: '−', and: '&', or: '|', xor: '^', imul: '×' };

function condHolds(cond, f) {
  switch (cond) {
    case 'e': return f.ZF;
    case 'ne': return !f.ZF;
    case 'l': return f.SF !== f.OF;
    case 'le': return f.ZF || f.SF !== f.OF;
    case 'g': return !f.ZF && f.SF === f.OF;
    case 'ge': return f.SF === f.OF;
    case 'b': return f.CF;
    case 'be': return f.CF || f.ZF;
    case 'a': return !f.CF && !f.ZF;
    case 'ae': return !f.CF;
    case 's': return f.SF;
    case 'ns': return !f.SF;
    default: throw new SimError('cond ' + cond);
  }
}
export const COND_WORDS = {
  e: ['equal', '='], ne: ['not equal', '≠'], l: ['less (signed)', '<'], le: ['less or equal (signed)', '≤'],
  g: ['greater (signed)', '>'], ge: ['greater or equal (signed)', '≥'], b: ['below (unsigned <)', '<'],
  be: ['below or equal (unsigned ≤)', '≤'], a: ['above (unsigned >)', '>'], ae: ['above or equal (unsigned ≥)', '≥'],
  s: ['negative (sign flag)', '<0'], ns: ['not negative', '≥0'],
};
/** Evaluate a condition directly on two numbers (used for "what if you read cmp backwards" hints). */
export function condOnNumbers(cond, x, y) {
  const ux = BigInt.asUintN(64, x), uy = BigInt.asUintN(64, y);
  switch (cond) {
    case 'e': return x === y; case 'ne': return x !== y;
    case 'l': return x < y; case 'le': return x <= y; case 'g': return x > y; case 'ge': return x >= y;
    case 'b': return ux < uy; case 'be': return ux <= uy; case 'a': return ux > uy; case 'ae': return ux >= uy;
    case 's': return x - y < 0n; case 'ns': return x - y >= 0n;
    default: return false;
  }
}

// ───────────────────────────── executor ─────────────────────────────

/**
 * Execute one parsed instruction on a copy of `m0`.
 * ctx: { syms, meta: { retSym, lib: { name, input, ret, out } }, quirk }
 * returns { m, steps, info } where info may contain { branch: {taken,target}, call: {target, lib}, ret: symId }
 */
export function exec(m0, ins, ctx = {}) {
  const m = clone(m0);
  const steps = [];
  const info = {};
  const q = ctx.quirk || null;
  const syms = ctx.syms || {};
  const meta = ctx.meta || {};
  const V = (b) => valText(b, syms);
  const say = (s) => steps.push(s);
  let ops = ins.operands.slice();
  const n = ins.size;
  const need = (k, kinds) => {
    if (ops.length !== k) throw new SimError(`${ins.mnem} expects ${k} operand(s)`);
    kinds.forEach((ks, i) => { if (!ks.includes(ops[i].t)) throw new SimError(`${ins.mnem}: bad operand ${ops[i].text}`); });
  };
  const writable = (o) => o.t === 'reg' || o.t === 'mem';

  /** Write `bytes` to operand `dst`. Handles partial-write explanations and several quirks. */
  const writeOp = (dst, bytes, { explainAs, srcValue } = {}) => {
    if (dst.t === 'reg') {
      const d = REG[dst.name];
      const opts = { zext: q !== 'zextMissing', zextSmall: q === 'zextExtra' };
      setReg(m, dst.name, bytes, opts);
      if (explainAs !== false) {
        let note = '';
        if (d.size === 4) note = ` {{writing a 32-bit register zero-extends: the upper 4 bytes of \`%${d.base}\` become 0 → \`%${d.base}\` = ${V(getReg(m, d.base))}}}`;
        else if (d.size < 4) note = ` {{only the low ${SIZE_WORD[d.size]} of \`%${d.base}\` change; the rest stays → \`%${d.base}\` = ${V(getReg(m, d.base))}}}`;
        say(`\`%${dst.name}\` ← ${explainAs || ''}**${V(bytes)}**${note}`);
      }
      return;
    }
    if (dst.t === 'mem') {
      const a = effAddr(m, dst, explainAs === false ? null : steps);
      if (bytes.length < 8 && q === 'fullWrite') {
        const slot = Math.floor(a / 8) * 8;
        const v = srcValue !== undefined ? srcValue : (toBig(bytes) ?? 0n);
        writeMem(m, slot, fromBig(v, 8));
        return;
      }
      if (bytes.length < 8 && q === 'bigEndian') {
        const slot = Math.floor(a / 8) * 8;
        const o = a - slot;
        const o2 = 8 - o - bytes.length;
        writeMem(m, slot + o2, bytes.slice().reverse());
        return;
      }
      writeMem(m, a, bytes);
      if (explainAs !== false) {
        const shown = bytes.length < 8 && bytes.every(isNum) ? String(toBig(bytes, false)) : V(bytes);
        say(`\`M[${a}]\` ← ${explainAs || ''}**${shown}**${bytes.length === 8 ? ` {{8 bytes: ${a} … ${a + 7}}}` : ''}`);
        if (bytes.length < 8) say(slotNote(m, a, bytes.length, syms));
      }
      return;
    }
    throw new SimError(`Can't write to ${dst.text}`);
  };

  switch (ins.op) {
    case 'nop': say('Does nothing.'); break;

    case 'push': {
      need(1, [['imm', 'reg', 'mem']]);
      const a = ops[0];
      const val = readOp(m, a, 8, steps);
      const rsp = regAddr(m, 'rsp');
      const nsp = rsp - 8;
      if (q === 'pushNoDec') { writeMem(m, rsp, val); break; }
      if (q === 'pushNoStore') { setRegNum(m, 'rsp', nsp); break; }
      if (q === 'pushUp') { setRegNum(m, 'rsp', rsp + 8); writeMem(m, rsp + 8, val); break; }
      if (q === 'pushStoreOld') { setRegNum(m, 'rsp', nsp); writeMem(m, rsp, val); break; }
      say(`\`%rsp\` ← ${rsp} − 8 = **${nsp}** {{first make room: the stack grows toward LOWER addresses}}`);
      setRegNum(m, 'rsp', nsp);
      writeMem(m, nsp, val);
      say(`\`M[${nsp}]\` ← ${opName(m0, a)} = **${V(val)}** {{then store 8 bytes at the new top}}`);
      break;
    }

    case 'pop': {
      need(1, [['reg', 'mem']]);
      const rsp = regAddr(m, 'rsp');
      const val = readMem(m, rsp, 8);
      const dst = ops[0];
      if (q === 'popErase') { writeMem(m, rsp, unk()); setRegNum(m, 'rsp', rsp + 8); writeOp(dst, val, { explainAs: false }); break; }
      if (q === 'popNoMove') { writeOp(dst, val, { explainAs: false }); break; }
      if (q === 'popDown') { setRegNum(m, 'rsp', rsp - 8); writeOp(dst, val, { explainAs: false }); break; }
      if (q === 'popNoReg') { setRegNum(m, 'rsp', rsp + 8); break; }
      say(`read the top: \`M[${rsp}]\` = **${V(val)}**`);
      setRegNum(m, 'rsp', rsp + 8);
      say(`\`%rsp\` ← ${rsp} + 8 = **${rsp + 8}** {{the value is NOT erased — it stays in memory at ${rsp}, just below %rsp now}}`);
      writeOp(dst, val, { explainAs: '' });
      break;
    }

    case 'mov': {
      need(2, [['imm', 'reg', 'mem'], ['reg', 'mem']]);
      if (ops[0].t === 'mem' && ops[1].t === 'mem') throw new SimError('mov cannot have two memory operands');
      let [src, dst] = ops;
      if (q === 'swap') { if (!writable(src)) throw new SimError('no swap'); [src, dst] = [dst, src]; }
      const size = src.t === 'reg' ? src.size : dst.t === 'reg' ? dst.size : n;
      if (q === 'fullWrite' && !(dst.t === 'mem' && size < 8)) throw new SimError('n/a');
      if (q === 'bigEndian' && !(dst.t === 'mem' && size < 8)) throw new SimError('n/a');
      if (q === 'zextMissing' && !(dst.t === 'reg' && dst.size === 4)) throw new SimError('n/a');
      if (q === 'zextExtra' && !(dst.t === 'reg' && dst.size < 4)) throw new SimError('n/a');
      const val = readOp(m, src, size, steps);
      const srcValue = src.t === 'imm' && !src.sym ? src.v : undefined;
      writeOp(dst, val, { explainAs: src.t === 'imm' ? '' : `${opName(m0, src)} = `, srcValue });
      break;
    }

    case 'movx': {
      need(2, [['reg', 'mem'], ['reg']]);
      const [src, dst] = ops;
      const from = src.t === 'reg' ? src.size : ins.ext.from;
      let val;
      if (q === 'fullRead') {
        if (src.t !== 'mem') throw new SimError('n/a');
        val = readMem(m, effAddr(m, src, null), 8);
      } else val = readOp(m, src, from, steps);
      const signed = q === 'signWrong' ? !ins.ext.signed : ins.ext.signed;
      const out = val.slice(0, dst.size);
      const top = val[from - 1];
      const fill = signed ? (isNum(top) ? (top & 0x80 ? 255 : 0) : null) : 0;
      while (out.length < dst.size) out.push(fill);
      setReg(m, dst.name, out);
      say(`reads **${SIZE_WORD[from]}** from ${opName(m0, src)} = ${valText(val, syms)} and ${signed ? 'sign' : 'zero'}-extends it to ${SIZE_WORD[dst.size]} {{${signed ? 'the new bytes copy the top bit of the value' : 'the new bytes are 0'} — the rest of the source slot is ignored}}`);
      say(`\`%${dst.name}\` ← **${V(getReg(m, dst.name))}**`);
      break;
    }

    case 'lea': {
      need(2, [['mem'], ['reg']]);
      const [src, dst] = ops;
      const a = effAddr(m, src, steps, 'address', q !== 'leaLoad');
      if (q === 'leaLoad') { setReg(m, dst.name, readMem(m, a, dst.size)); break; }
      setReg(m, dst.name, fromBig(BigInt(a), dst.size));
      say(`\`%${dst.name}\` ← **${a}** {{lea only computes the address — it never reads memory}}`);
      break;
    }

    case 'add': case 'sub': case 'and': case 'or': case 'xor': {
      need(2, [['imm', 'reg', 'mem'], ['reg', 'mem']]);
      if (ops[0].t === 'mem' && ops[1].t === 'mem') throw new SimError('two memory operands');
      let [src, dst] = ops;
      let kind = ins.op;
      if (q === 'swap') { if (!writable(src)) throw new SimError('no swap'); [src, dst] = [dst, src]; }
      if (q === 'rspWrongDir') {
        if (!(dst.t === 'reg' && dst.name === 'rsp' && (kind === 'add' || kind === 'sub'))) throw new SimError('n/a');
        kind = kind === 'add' ? 'sub' : 'add';
      }
      const size = dst.t === 'reg' ? dst.size : src.t === 'reg' ? src.size : n;
      if (dst.t === 'mem') effAddr(m, dst, steps);
      const x = readOp(m, dst, size, null);
      const y = readOp(m, src, size, steps);
      let r;
      const selfXor = kind === 'xor' && src.t === 'reg' && dst.t === 'reg' && src.name === dst.name;
      if (q === 'subRev') { if (kind !== 'sub') throw new SimError('n/a'); r = alu('sub', y, x, size); }
      else if (selfXor) r = { bytes: fromBig(0n, size), flags: { ZF: true, SF: false, CF: false, OF: false } };
      else r = alu(kind, x, y, size);
      m.flags = r.flags; m.cmp = null;
      const dn = opName(m0, dst), sn = opName(m0, src);
      if (dst.t === 'reg' && dst.name === 'rsp' && src.t === 'imm' && (kind === 'sub' || kind === 'add')) {
        const note = kind === 'sub'
          ? `{{allocates ${src.v} bytes (${Number(src.v) / 8} slot${src.v === 8n ? '' : 's'}) — nothing is written, the new slots hold whatever garbage was there}}`
          : `{{frees ${src.v} bytes — nothing is erased, %rsp just moves up}}`;
        say(`\`%rsp\` ← ${V(x)} ${SYM_OF[kind]} ${src.v} = **${V(r.bytes)}** ${note}`);
        setReg(m, 'rsp', r.bytes);
        break;
      }
      const cx = classify(x), cy = classify(y);
      if (selfXor) {
        say(`x ^ x = 0 for any x → ${dn} ← **0** {{the classic way to zero a register}}`);
      } else if (r.unknown && kind === 'add' && cx.kind === 'sym' && cy.kind === 'sym' && cx.s === cy.s) {
        say(`${dn} ← ${dn} + ${sn} = ${V(x)} + ${V(y)} = 2 × ${V(x)} → **?** {{not a number we know, so it is unknown here — on the exam you would write “2× return address”}}`);
      } else if (r.unknown) {
        say(`${dn} ← ${dn} ${SYM_OF[kind]} ${sn} = ${V(x)} ${SYM_OF[kind]} ${V(y)} → **?** {{an unknown or symbolic operand makes the result unknown garbage}}`);
      } else {
        say(`${dn} ← ${dn} ${SYM_OF[kind]} ${sn} = ${neg(toBig(x))} ${SYM_OF[kind]} ${neg(toBig(y))} = **${V(r.bytes)}**${kind === 'sub' ? ' {{AT&T: destination − source}}' : ''}`);
      }
      writeOp(dst, r.bytes, { explainAs: false });
      break;
    }

    case 'inc': case 'dec': case 'neg': case 'not': {
      need(1, [['reg', 'mem']]);
      const dst = ops[0];
      const size = dst.t === 'reg' ? dst.size : n;
      const x = readOp(m, dst, size, steps);
      const xv = toBig(x);
      let rb;
      if (xv === null) {
        rb = unk(size);
        if (ins.op !== 'not') { m.flags = null; m.cmp = null; }
      } else {
        const bits = size * 8;
        const max = (1n << BigInt(bits - 1)) - 1n, min = -(1n << BigInt(bits - 1));
        const r = ins.op === 'inc' ? xv + 1n : ins.op === 'dec' ? xv - 1n : ins.op === 'neg' ? -xv : ~xv;
        rb = fromBig(BigInt.asIntN(bits, r), size);
        const rs = BigInt.asIntN(bits, r);
        const prevCF = m.flags ? m.flags.CF : false;
        if (ins.op === 'inc') m.flags = { ZF: rs === 0n, SF: rs < 0n, CF: prevCF, OF: xv === max };
        else if (ins.op === 'dec') m.flags = { ZF: rs === 0n, SF: rs < 0n, CF: prevCF, OF: xv === min };
        else if (ins.op === 'neg') m.flags = { ZF: rs === 0n, SF: rs < 0n, CF: xv !== 0n, OF: xv === min };
        if (ins.op !== 'not') m.cmp = null;
      }
      const word = { inc: '+ 1', dec: '− 1', neg: '→ negate', not: '→ flip every bit' }[ins.op];
      say(`${opName(m0, dst)} ← ${V(x)} ${word} = **${V(rb)}**${ins.op === 'not' ? ' {{not x = −x − 1}}' : ''}`);
      writeOp(dst, rb, { explainAs: false });
      break;
    }

    case 'shl': case 'sal': case 'shr': case 'sar': {
      let cnt, dst;
      if (ops.length === 1) { cnt = 1n; dst = ops[0]; }
      else {
        need(2, [['imm', 'reg'], ['reg', 'mem']]);
        dst = ops[1];
        if (ops[0].t === 'imm') cnt = ops[0].v;
        else { if (ops[0].name !== 'cl') throw new SimError('shift count must be $imm or %cl'); cnt = toBig(getReg(m, 'cl'), false); }
      }
      const size = dst.t === 'reg' ? dst.size : n;
      const bits = size * 8;
      const x = readOp(m, dst, size, steps);
      const xu = toBig(x, false);
      let rb;
      const k = cnt === null ? null : cnt & (size === 8 ? 63n : 31n);
      if (xu === null || k === null) {
        rb = unk(size);
        if (k !== 0n) { m.flags = null; m.cmp = null; }
      } else {
        const B = BigInt(bits);
        const top = (v) => (v >> (B - 1n)) & 1n;
        let r, CF;
        if (ins.op === 'shl' || ins.op === 'sal') { r = xu << k; CF = k <= B ? (xu >> (B - k)) & 1n : 0n; }
        else if (ins.op === 'shr') { r = xu >> k; CF = (xu >> (k - 1n)) & 1n; }
        else { r = BigInt.asIntN(bits, xu) >> k; CF = (BigInt.asIntN(bits, xu) >> (k - 1n)) & 1n; }
        const ru = BigInt.asUintN(bits, r);
        rb = fromBig(ru, size);
        if (k !== 0n) {
          let OF = false;
          if (k === 1n) OF = ins.op === 'shr' ? top(xu) === 1n : ins.op === 'sar' ? false : (top(ru) ^ CF) === 1n;
          m.flags = { ZF: ru === 0n, SF: top(ru) === 1n, CF: CF === 1n, OF };
          m.cmp = null;
        }
      }
      const kk = k === null ? cnt : k;
      const how = { shl: `× 2^${kk}`, sal: `× 2^${kk}`, shr: `÷ 2^${kk}, logical: fills with 0s`, sar: `÷ 2^${kk}, arithmetic: keeps the sign and rounds DOWN (−7 >> 1 = −4)` }[ins.op];
      say(`${opName(m0, dst)} ← ${V(x)} ${ins.op === 'shl' || ins.op === 'sal' ? '<<' : '>>'} ${kk} {{= ${how}}} = **${V(rb)}**`);
      writeOp(dst, rb, { explainAs: false });
      break;
    }

    case 'imul': {
      if (ops.length === 1) return execMulLike(m, ops[0], true, steps, info, q, V, n);
      if (ops.length === 2) {
        let [src, dst] = ops;
        if (dst.t !== 'reg') throw new SimError('imul destination must be a register');
        if (q === 'swap') throw new SimError('n/a');
        const size = dst.size;
        const x = readOp(m, dst, size, null);
        const y = readOp(m, src, size, steps);
        const r = alu('imul', x, y, size);
        m.flags = r.flags; m.cmp = null;
        say(`\`%${dst.name}\` ← \`%${dst.name}\` × ${opName(m0, src)} = ${V(x)} × ${V(y)} = **${V(r.bytes)}**`);
        writeOp(dst, r.bytes, { explainAs: false });
        break;
      }
      need(3, [['imm'], ['reg', 'mem'], ['reg']]);
      const [imm, src, dst] = ops;
      const y = readOp(m, src, dst.size, steps);
      const r = alu('imul', y, fromBig(imm.v, dst.size), dst.size);
      m.flags = r.flags; m.cmp = null;
      say(`\`%${dst.name}\` ← ${opName(m0, src)} × ${imm.v} = ${V(y)} × ${imm.v} = **${V(r.bytes)}**`);
      writeOp(dst, r.bytes, { explainAs: false });
      break;
    }

    case 'mul': {
      need(1, [['reg', 'mem']]);
      return execMulLike(m, ops[0], false, steps, info, q, V, n);
    }

    case 'div': case 'idiv': {
      need(1, [['reg', 'mem']]);
      if (ins.size !== 8) throw new SimError('only 64-bit div/idiv are supported');
      const divB = readOp(m, ops[0], 8, steps);
      const dv = toBig(divB, ins.op === 'div' ? false : true);
      const lo = toBig(getReg(m, 'rax'), false), hi = toBig(getReg(m, 'rdx'), false);
      if (dv === null || lo === null || hi === null) {
        setReg(m, 'rax', unk()); setReg(m, 'rdx', unk());
        say('An operand is unknown → `%rax` and `%rdx` become **?**');
        break;
      }
      if (dv === 0n) throw new SimError('division by zero');
      let dividend = (hi << 64n) | lo;
      if (ins.op === 'idiv') dividend = BigInt.asIntN(128, dividend);
      const quo = dividend / dv, rem = dividend % dv; // BigInt division truncates toward zero, like x86
      if (ins.op === 'div' ? quo >= (1n << 64n) : quo !== BigInt.asIntN(64, quo)) throw new SimError('#DE: quotient does not fit in 64 bits');
      setReg(m, 'rax', fromBig(quo)); setReg(m, 'rdx', fromBig(rem));
      say(`divides \`%rdx:%rax\` (= ${dividend}) by ${opName(m0, ops[0])} (= ${dv})`);
      say(`\`%rax\` ← quotient **${BigInt.asIntN(64, BigInt.asUintN(64, quo))}**, \`%rdx\` ← remainder **${BigInt.asIntN(64, BigInt.asUintN(64, rem))}**`);
      break;
    }

    case 'cqto': {
      const ra = toBig(getReg(m, 'rax'));
      setReg(m, 'rdx', ra === null ? unk() : fromBig(ra < 0n ? -1n : 0n));
      say(`\`%rdx\` ← sign of \`%rax\` repeated 64 times = **${ra === null ? '?' : ra < 0n ? -1 : 0}** {{prepares %rdx:%rax for idiv}}`);
      break;
    }

    case 'cmp': case 'test': {
      need(2, [['imm', 'reg', 'mem'], ['reg', 'mem']]);
      const [src, dst] = ops;
      const size = dst.t === 'reg' ? dst.size : src.t === 'reg' ? src.size : n;
      const x = readOp(m, dst, size, steps);
      const y = readOp(m, src, size, steps);
      const r = alu(ins.op === 'cmp' ? 'sub' : 'and', x, y, size);
      m.flags = r.flags;
      if (ins.op === 'cmp') {
        m.cmp = { dst: dst.text, src: src.text, x: toBig(x), y: toBig(y), size };
        say(`compares ${opName(m0, dst)} with ${opName(m0, src)}: computes ${V(x)} − ${V(y)} {{AT&T: destination − source}} and only sets the flags`);
      } else {
        m.cmp = null;
        say(`computes ${V(x)} & ${V(y)} and only sets the flags`);
      }
      say('The result is thrown away: **no register or stack slot changes.**');
      break;
    }

    case 'jmp': {
      need(1, [['label']]);
      info.branch = { taken: true, target: ops[0].name };
      say(`Unconditional jump to \`${ops[0].name}\` — the stack is untouched.`);
      break;
    }

    case 'jcc': {
      need(1, [['label']]);
      const f = m.flags;
      if (!f) throw new SimError('flags unknown');
      const taken = condHolds(ins.cond, f);
      info.branch = { taken, target: ops[0].name };
      const [word, sym] = COND_WORDS[ins.cond];
      if (m.cmp && m.cmp.x !== null && m.cmp.y !== null) {
        const uns = ['b', 'be', 'a', 'ae'].includes(ins.cond);
        const show = (v) => (uns ? String(BigInt.asUintN((m.cmp.size || 8) * 8, v)) : neg(v));
        say(`the last \`cmp\` compared \`${m.cmp.dst}\` (= ${m.cmp.x}) with \`${m.cmp.src}\` (= ${m.cmp.y})`);
        say(`\`${ins.mnem}\` jumps if ${word}: is ${show(m.cmp.x)} ${sym} ${show(m.cmp.y)}${uns ? ' (as unsigned numbers)' : ''}? → **${taken ? 'yes — jump taken' : 'no — not taken, fall through to the next line'}**`);
      } else {
        say(`\`${ins.mnem}\` jumps if ${word} (based on the flags) → **${taken ? 'taken' : 'not taken'}**`);
      }
      say('{{a jump only changes %rip — the stack and registers stay the same}}');
      break;
    }

    case 'call': {
      need(1, [['label']]);
      const target = ops[0].name;
      const rsp = regAddr(m, 'rsp');
      const nsp = rsp - 8;
      const ret = symBytes(meta.retSym || 'ret?');
      const lib = meta.lib || null;
      const retL = symLabel(meta.retSym, syms);
      info.call = { target, lib };
      if (!lib) {
        if (q === 'callNoPush') break;
        if (q === 'callNoMove') { writeMem(m, nsp, ret); break; }
        if (q === 'callStoreOld') { setRegNum(m, 'rsp', nsp); writeMem(m, rsp, ret); break; }
        if (q && q.startsWith('lib')) throw new SimError('n/a');
        setRegNum(m, 'rsp', nsp);
        say(`\`%rsp\` ← ${rsp} − 8 = **${nsp}** {{call = push the return address …}}`);
        writeMem(m, nsp, ret);
        say(`\`M[${nsp}]\` ← return address **${retL}** {{the address of the instruction right after this call}}`);
        say(`{{… then jump to}} \`${target}\``);
        break;
      }
      // Library call (scanf/printf): model the whole call as one step.
      if (q && !['libNoStale', 'libNoInput', 'libNoPop', 'callNoPush'].includes(q)) throw new SimError('n/a');
      if (q !== 'libNoStale' && q !== 'callNoPush') writeMem(m, nsp, ret);
      if (q === 'libNoPop') setRegNum(m, 'rsp', nsp);
      say(`\`call\` pushes the return address: \`%rsp\` ← ${rsp} − 8 = ${nsp}, \`M[${nsp}]\` ← **${retL}**`);
      if (lib.name === 'scanf') {
        const dest = regAddr(m, 'rsi');
        if (q !== 'libNoInput') writeMem(m, dest, fromBig(lib.input));
        say(`\`scanf("%ld", %rsi)\`: you type **${lib.input}** → it is stored (8 bytes) at the address in \`%rsi\` = ${dest}: \`M[${dest}]\` ← **${lib.input}**`);
      } else if (lib.name === 'printf') {
        say(`\`printf\` prints ${JSON.stringify(lib.out)} to the terminal`);
      }
      if (lib.ret !== undefined) {
        setReg(m, 'rax', fromBig(lib.ret));
        say(`it returns **${lib.ret}** in \`%rax\` {{${lib.name === 'scanf' ? 'number of items read' : 'number of characters printed'}}}`);
      }
      say(`its \`ret\` pops the return address: \`%rsp\` ← ${nsp} + 8 = **${rsp}** — but **${retL} is still sitting in memory at ${nsp}** {{popping never erases}}`);
      say('{{caller-saved registers (%rdi, %rsi, %rdx, %rcx, %r8–%r11) may be changed by any call — never rely on them afterwards. This game leaves their values alone and never reads them again before they are rewritten.}}');
      break;
    }

    case 'ret': {
      if (ops.length) throw new SimError('ret takes no operands here');
      const rsp = regAddr(m, 'rsp');
      const val = readMem(m, rsp, 8);
      const c = classify(val);
      info.ret = c.kind === 'sym' ? c.s : null;
      if (q === 'retNoMove') break;
      if (q === 'retErase') { writeMem(m, rsp, unk()); setRegNum(m, 'rsp', rsp + 8); break; }
      say(`pops the return address \`M[${rsp}]\` = **${V(val)}** into \`%rip\` {{ret = popq %rip}}`);
      setRegNum(m, 'rsp', rsp + 8);
      say(`\`%rsp\` ← ${rsp} + 8 = **${rsp + 8}** {{the return address stays in memory; execution continues in the caller}}`);
      break;
    }

    case 'leave': {
      if (ops.length) throw new SimError('leave takes no operands');
      const rbp = regAddr(m, 'rbp');
      if (q === 'leavePopOnly') {
        const rsp = regAddr(m, 'rsp');
        setReg(m, 'rbp', readMem(m, rsp, 8)); setRegNum(m, 'rsp', rsp + 8);
        break;
      }
      say('`leave` = `movq %rbp, %rsp` + `popq %rbp`');
      setRegNum(m, 'rsp', rbp);
      say(`\`%rsp\` ← \`%rbp\` = **${rbp}** {{throws away all locals of this frame}}`);
      if (q === 'leaveMovOnly') break;
      const val = readMem(m, rbp, 8);
      setReg(m, 'rbp', val);
      setRegNum(m, 'rsp', rbp + 8);
      say(`\`%rbp\` ← \`M[${rbp}]\` = **${V(val)}**, \`%rsp\` ← ${rbp} + 8 = **${rbp + 8}**`);
      break;
    }

    default:
      throw new SimError(`Unsupported instruction ${ins.mnem}`);
  }
  return { m, steps, info };
}

function execMulLike(m, srcOp, signed, steps, info, q, V, n) {
  const size = srcOp.t === 'reg' ? srcOp.size : n;
  if (size !== 8) throw new SimError('only 64-bit mul is supported');
  const y = readOp(m, srcOp, 8, steps);
  const x = getReg(m, 'rax');
  const xv = toBig(x, signed), yv = toBig(y, signed);
  if (xv === null || yv === null) {
    setReg(m, 'rax', unk());
    if (q !== 'mulNoRdx') setReg(m, 'rdx', unk());
    steps.push('An operand is unknown → `%rdx:%rax` becomes **?**');
    return { m, steps, info };
  }
  const p = xv * yv;
  const pu = BigInt.asUintN(128, p);
  const lo = BigInt.asUintN(64, pu), hi = pu >> 64n;
  setReg(m, 'rax', fromBig(lo));
  if (q !== 'mulNoRdx') setReg(m, 'rdx', fromBig(hi));
  m.flags = null; m.cmp = null;
  steps.push(`\`%rdx:%rax\` ← \`%rax\` × ${srcOp.t === 'reg' ? '`%' + srcOp.name + '`' : '`' + srcOp.text + '`'} = ${xv} × ${yv} = ${p}`);
  steps.push(`\`%rax\` ← low 64 bits = **${BigInt.asIntN(64, lo)}**, \`%rdx\` ← high 64 bits = **${BigInt.asIntN(64, hi)}** {{${signed ? 'imul' : 'mul'} with one operand always writes BOTH registers}}`);
  return { m, steps, info };
}

/** Numeric-only convenience for tests & generators. */
export function regVal(m, name) {
  return toBig(getReg(m, name));
}
