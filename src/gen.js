// Endless routine generator. Produces exam-style subroutines, ramping difficulty by tier.

import { SimError, classify, getReg, readMem, regNum, subscript, writeMem, fromBig, isNum } from './sim.js';
import { makeStep, baseSyms, entryMachine } from './trace.js';

export const TIERS = [
  { name: 'Warm-up', desc: 'push · pop · mov · add/sub', min: 0 },
  { name: 'Frames', desc: 'locals · offsets · epilogue', min: 10 },
  { name: 'Bytes & branches', desc: 'movb/movl · lea · cmp/jcc · leave · calls', min: 28 },
  { name: 'Exam boss', desc: 'scanf · stack args · dirty memory · mul', min: 55 },
];
export function tierForScore(score) {
  let t = 0;
  TIERS.forEach((x, i) => { if (score >= x.min) t = i; });
  return t;
}

export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}

const FN_NAMES = ['blinds', 'lights', 'tally', 'vault', 'sonar', 'hatch', 'crane', 'relay', 'pulse', 'orbit', 'drift', 'forge',
  'prism', 'ember', 'quill', 'radar', 'lever', 'piston', 'turbo', 'nimbus', 'beacon', 'gizmo', 'kettle', 'lantern'];
const HELPERS = ['helper', 'bump', 'twice', 'clamp', 'square', 'nudge', 'boost', 'tweak'];
const LABELS = ['calculation', 'skip', 'done', 'small', 'big', 'next', 'cont', 'positive', 'finish', 'later', 'end_if'];
const LOW8 = { rax: 'al', rcx: 'cl', rdx: 'dl', rsi: 'sil', rdi: 'dil', r8: 'r8b', r9: 'r9b' };
const LOW16 = { rax: 'ax', rcx: 'cx', rdx: 'dx', rsi: 'si', rdi: 'di', r8: 'r8w', r9: 'r9w' };
const LOW32 = { rax: 'eax', rcx: 'ecx', rdx: 'edx', rsi: 'esi', rdi: 'edi', r8: 'r8d', r9: 'r9d' };
const REG_ORDER = ['rax', 'rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'rbp', 'rsp'];
// Scratch registers are all caller-saved, so a routine may freely leave them changed.
const CALLER_SAVED = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9', 'r10', 'r11'];

/** Registers an instruction overwrites without reading (so a clobbered register becomes trustworthy again). */
function pureWrites(ins) {
  const ops = ins.operands;
  const dst = ops[ops.length - 1];
  if (['mov', 'movx', 'lea', 'pop'].includes(ins.op) && dst && dst.t === 'reg' && dst.size >= 4) return [dst.base];
  if (ins.op === 'xor' && ops[0].t === 'reg' && dst.t === 'reg' && ops[0].name === dst.name) return [dst.base];
  if (ins.op === 'mul' || (ins.op === 'imul' && ops.length === 1)) return ['rax', 'rdx'];
  return [];
}

const memText = (disp, base) => (disp === 0 ? `(%${base})` : `${disp}(%${base})`);

class Builder {
  constructor(o) {
    Object.assign(this, o);
    this.steps = [];
    this.pendingLabel = null;
    this.retN = 0;
    this.fnStack = [this.fn];
    this.minRsp = this.S - 8 * 12;
    this.inHelper = false;
    this.usedLabels = new Set();
    this.clobbered = new Set(); // caller-saved registers whose value is undefined after a library call
  }
  get rsp() { return regNum(this.m, 'rsp'); }
  get rbp() { return regNum(this.m, 'rbp'); }
  frame() { const b = this.rbp; return b === null ? 0 : b - this.rsp; }
  val(r) { const c = classify(getReg(this.m, r)); return c.kind === 'num' ? c.v : null; }
  slot(addr) { return classify(readMem(this.m, addr, 8)); }
  usable() { return [...this.args, ...this.scratch]; }
  known() { return this.usable().filter((r) => this.val(r) !== null && !this.clobbered.has(r)); }
  small(r, lim = 5000n) { const v = this.val(r); return v !== null && v <= lim && v >= -lim; }
  imm(lo = null, hi = null) {
    const R = this.R, t = this.tier;
    if (lo !== null) return R.int(lo, hi);
    if (t === 0) return R.int(1, 20);
    if (t === 1) return R.chance(0.15) ? -R.int(1, 20) : R.int(1, 99);
    return R.chance(0.2) ? -R.int(1, 64) : R.pick([R.int(1, 99), R.int(1, 99), R.int(100, 300), R.pick([8, 16, 32, 64, 100, 128, 255, 256])]);
  }
  fnName() { return this.fnStack[this.fnStack.length - 1]; }
  label() {
    const free = LABELS.filter((l) => !this.usedLabels.has(l));
    const l = this.R.pick(free.length ? free : LABELS);
    this.usedLabels.add(l);
    return l;
  }
  newRet(callText) {
    this.retN++;
    const id = 'ret' + this.retN;
    this.syms[id] = { label: 'ret' + subscript(this.retN), kind: 'ret', desc: `return address pushed by \`${callText}\`` };
    return id;
  }
  /** A slot inside the current frame, addressed via %rsp or %rbp. filter(kind) decides which contents are OK. */
  frameSlot(filter = () => true, preferRbp = null) {
    const fr = this.frame();
    if (fr < 8) return null;
    const cands = [];
    for (let a = this.rsp; a < this.rsp + fr; a += 8) if (filter(this.slot(a), a)) cands.push(a);
    if (!cands.length) return null;
    const addr = this.R.pick(cands);
    const useRbp = preferRbp !== null ? preferRbp : this.R.chance(0.5);
    const text = useRbp ? memText(addr - this.rbp, 'rbp') : memText(addr - this.rsp, 'rsp');
    return { addr, text };
  }
  okContent(c) { return this.tier >= 3 ? c.kind !== 'sym' : c.kind === 'num'; }

  /** Try a list of items atomically. */
  tryChunk(items, { allowUnknown = false } = {}) {
    let m = this.m;
    const out = [];
    let label = this.pendingLabel;
    for (const it of items) {
      let st;
      try {
        st = makeStep(m, { ...it, label: it.label || label, fn: it.fn || this.fnName() }, this.syms);
      } catch (e) {
        if (e instanceof SimError) return false;
        throw e;
      }
      label = null;
      if (!this.valid(st, allowUnknown || it.allowUnknown)) return false;
      out.push(st);
      m = st.after;
      if (it.labelAfter) label = it.labelAfter;
    }
    this.steps.push(...out);
    this.m = m;
    this.pendingLabel = label;
    for (const st of out) {
      if (st.ins.op === 'call' && st.meta.lib) CALLER_SAVED.forEach((r) => this.clobbered.add(r));
      else pureWrites(st.ins).forEach((r) => this.clobbered.delete(r));
    }
    return true;
  }
  emit(text, extra = {}) {
    if (!this.tryChunk([{ text, ...extra }], { allowUnknown: true })) throw new SimError('emit failed: ' + text);
  }
  valid(st, allowUnknown) {
    const m = st.after;
    const rsp = regNum(m, 'rsp');
    if (rsp === null || rsp < this.minRsp || rsp > this.S + 8) return false;
    for (const r of this.regs) {
      const a = classify(getReg(st.before, r)), b = classify(getReg(m, r));
      if (b.kind === 'num' && (b.v > 99999n || b.v < -99999n) && !(a.kind === 'num' && a.v === b.v) && r !== 'rsp' && r !== 'rbp') return false;
      if (!allowUnknown && a.kind === 'num' && (b.kind === 'unk' || b.kind === 'mixed') && !(this.tier >= 3 && this.R.chance(0.5))) return false;
    }
    // changed memory must stay sane
    for (let a = this.minRsp - 8; a <= this.S + 8; a += 8) {
      const b1 = readMem(st.before, a, 8), b2 = readMem(m, a, 8);
      const c = classify(b2);
      if (c.kind === 'num' && (c.v > 99999999n || c.v < -99999999n) && JSON.stringify(b1) !== JSON.stringify(b2)) return false;
    }
    if (st.ins.op === 'jcc' && !st.info.branch) return false;
    return true;
  }
}

// ───────────────────────────── op catalogue ─────────────────────────────
// weights per tier [t0, t1, t2, t3]

const OPS = [
  { id: 'pushImm', w: [3, 2, 1.3, 1], make: (b) => (b.rsp - 8 >= b.minRsp ? [{ text: `pushq $${b.imm()}` }] : null) },
  {
    id: 'pushReg', w: [3, 2, 1.3, 1],
    make: (b) => {
      const k = b.known();
      if (!k.length) return null;
      return [{ text: `pushq %${b.R.pick(k)}` }];
    },
  },
  {
    id: 'popReg', w: [3, 2.2, 1.5, 1.5],
    make: (b) => {
      if (b.frame() < 8) return null;
      if (!b.okContent(b.slot(b.rsp))) return null;
      return [{ text: `popq %${b.R.pick(b.usable())}` }];
    },
  },
  { id: 'movImmReg', w: [1.5, 0.8, 0.6, 0.5], make: (b) => [{ text: `movq $${b.imm()}, %${b.R.pick(b.usable())}` }] },
  {
    id: 'movRegReg', w: [1.2, 0.8, 0.6, 0.5],
    make: (b) => {
      const k = b.known(), u = b.usable();
      if (!k.length || u.length < 2) return null;
      const a = b.R.pick(k);
      const d = b.R.pick(u.filter((r) => r !== a));
      return [{ text: `movq %${a}, %${d}` }];
    },
  },
  {
    id: 'arithImm', w: [1.2, 0.8, 0.6, 0.5],
    make: (b) => {
      const k = b.known();
      if (!k.length) return null;
      return [{ text: `${b.R.pick(['addq', 'subq'])} $${b.imm(1, b.tier ? 50 : 10)}, %${b.R.pick(k)}` }];
    },
  },
  {
    id: 'arithReg', w: [0.6, 0.7, 0.6, 0.5],
    make: (b) => {
      const k = b.known();
      if (k.length < 2) return null;
      const a = b.R.pick(k), d = b.R.pick(k.filter((r) => r !== a));
      return [{ text: `${b.R.pick(['addq', 'subq'])} %${a}, %${d}` }];
    },
  },
  {
    id: 'subRsp', w: [0, 2.2, 1.3, 1],
    make: (b) => {
      const k = b.R.pick([1, 2, 2, 3]);
      if (b.rsp - 8 * k < b.minRsp + 16) return null;
      return [{ text: `subq $${8 * k}, %rsp` }];
    },
  },
  {
    id: 'addRsp', w: [0, 0.8, 0.8, 0.8],
    make: (b) => {
      const k = b.R.pick([1, 1, 2]);
      if (b.frame() < 8 * k) return null;
      return [{ text: `addq $${8 * k}, %rsp` }];
    },
  },
  {
    id: 'storeMem', w: [0, 3, 1.8, 1.4],
    make: (b) => {
      const s = b.frameSlot();
      if (!s) return null;
      const k = b.known();
      const src = k.length && b.R.chance(0.5) ? `%${b.R.pick(k)}` : `$${b.imm()}`;
      return [{ text: `movq ${src}, ${s.text}` }];
    },
  },
  {
    id: 'loadMem', w: [0, 1.8, 1.3, 1.2],
    make: (b) => {
      const s = b.frameSlot((c) => b.okContent(c));
      if (!s) return null;
      return [{ text: `movq ${s.text}, %${b.R.pick(b.usable())}` }];
    },
  },
  {
    id: 'incdec', w: [0, 0.6, 0.5, 0.4],
    make: (b) => {
      const k = b.known();
      if (!k.length) return null;
      return [{ text: `${b.R.pick(['incq', 'decq'])} %${b.R.pick(k)}` }];
    },
  },
  {
    id: 'partial', w: [0, 0, 3.2, 2.4],
    make: (b) => {
      const s = b.frameSlot((c) => c.kind === 'unk' || (c.kind === 'num' && c.v >= 0n && c.v < 1000000n) || (b.tier >= 3 && c.kind === 'mixed'));
      if (!s) return null;
      const sz = b.R.pick(['b', 'b', 'b', 'w', 'l']);
      const size = { b: 1, w: 2, l: 4 }[sz];
      let off = 0;
      if (b.tier >= 3 && b.R.chance(0.35)) off = b.R.pick({ 1: [1, 2, 4], 2: [2, 4], 4: [4] }[size]);
      const v = sz === 'b' ? b.R.pick([b.R.int(0, 127), b.R.int(1, 64), 255, 32, 2]) : sz === 'w' ? b.R.int(256, 999) : b.R.int(0, 50000);
      const base = s.text.includes('rbp') ? 'rbp' : 'rsp';
      const disp = s.addr + off - (base === 'rbp' ? b.rbp : b.rsp);
      return [{ text: `mov${sz} $${v}, ${memText(disp, base)}` }];
    },
  },
  {
    id: 'lea', w: [0, 0, 1.2, 1],
    make: (b) => {
      const s = b.frameSlot();
      if (!s) return null;
      return [{ text: `leaq ${s.text}, %${b.R.pick(b.usable())}` }];
    },
  },
  {
    id: 'pushMem', w: [0, 0, 0.8, 0.8],
    make: (b) => {
      if (b.rsp - 8 < b.minRsp) return null;
      const s = b.frameSlot((c) => b.okContent(c));
      if (!s) return null;
      return [{ text: `pushq ${s.text}` }];
    },
  },
  {
    id: 'branch', w: [0, 0, 1.5, 1.2],
    make: (b) => {
      const k = b.known().filter((r) => b.small(r));
      if (!k.length) return null;
      const R = b.R;
      const r = R.pick(k);
      const x = Number(b.val(r));
      const cond = R.pick(['l', 'l', 'g', 'e', 'ne', 'le', 'ge']);
      const taken = R.chance(0.5);
      const d = R.int(1, 60);
      const y = {
        e: taken ? x : x + (R.chance(0.5) ? d : -d),
        ne: taken ? x + (R.chance(0.5) ? d : -d) : x,
        l: taken ? x + d : x - R.int(0, 60),
        le: taken ? x + R.int(0, 60) : x - d,
        g: taken ? x - d : x + R.int(0, 60),
        ge: taken ? x - R.int(0, 60) : x + d,
      }[cond];
      const label = b.label();
      const block = [];
      const n = R.int(1, 2);
      for (let i = 0; i < n; i++) {
        block.push(R.pick([`pushq $${b.imm()}`, `movq $${b.imm()}, %${R.pick(b.usable())}`, `addq $${b.imm(1, 20)}, %${R.pick(k)}`]));
      }
      const items = [{ text: `cmpq $${y}, %${r}` }, { text: `j${cond} ${label}`, skipped: taken ? block : null, labelAfter: taken ? label : null }];
      if (!taken) block.forEach((t, i) => items.push({ text: t, labelAfter: i === block.length - 1 ? label : null }));
      return items;
    },
  },
  {
    id: 'logic', w: [0, 0, 1, 0.8],
    make: (b) => {
      const k = b.known().filter((r) => b.small(r, 2000n));
      if (!k.length) return null;
      const R = b.R;
      const r = R.pick(k);
      const x = b.val(r);
      const opts = [`xorq %${r}, %${r}`, `andq $${R.pick([1, 3, 7, 15, 255])}, %${r}`, `orq $${R.pick([1, 2, 4, 8, 16])}, %${r}`, `negq %${r}`];
      if (b.small(r, 300n)) opts.push(`shlq $${R.int(1, 2)}, %${r}`, `imulq $${R.int(2, 4)}, %${r}`);
      if (x >= 0n) opts.push(`shrq $${R.int(1, 2)}, %${r}`);
      if (x < 0n) opts.push(`sarq $1, %${r}`);
      if (b.tier >= 3) opts.push(`notq %${r}`);
      const other = k.filter((q) => q !== r && b.small(q, 50n));
      if (other.length && b.small(r, 50n)) opts.push(`imulq %${R.pick(other)}, %${r}`);
      return [{ text: R.pick(opts) }];
    },
  },
  {
    id: 'helper', w: [0, 0, 0.6, 1.1],
    make: (b) => {
      if (b.inHelper || b.rsp - 40 < b.minRsp || !b.regs.includes('rax')) return null;
      const R = b.R;
      const h = R.pick(HELPERS);
      const caller = b.fnName();
      const items = [];
      const withArg = R.chance(0.6);
      if (withArg) {
        const k = b.known().filter((r) => b.small(r, 999n));
        items.push({ text: k.length && R.chance(0.5) ? `pushq %${R.pick(k)}` : `pushq $${b.imm(1, 99)}`, fn: caller });
      }
      const retSym = b.newRet(`call ${h}`);
      items.push({ text: `call ${h}`, meta: { retSym }, fn: caller });
      items.push({ text: 'pushq %rbp', fn: h, label: h });
      items.push({ text: 'movq %rsp, %rbp', fn: h });
      if (withArg) {
        items.push({ text: 'movq 16(%rbp), %rax', fn: h });
        if (R.chance(0.7)) items.push({ text: R.pick([`addq $${R.int(1, 20)}, %rax`, 'imulq $2, %rax', `subq $${R.int(1, 9)}, %rax`, 'shlq $1, %rax']), fn: h });
      } else {
        const v = b.imm(1, 99);
        items.push({ text: `pushq $${v}`, fn: h });
        items.push({ text: R.pick([`popq %rax`, `addq $${R.int(1, 9)}, (%rsp)`]), fn: h });
        if (items[items.length - 1].text.startsWith('addq')) items.push({ text: 'popq %rax', fn: h });
      }
      const epi = R.pick([['popq %rbp'], ['leave'], ['movq %rbp, %rsp', 'popq %rbp']]);
      epi.forEach((t) => items.push({ text: t, fn: h }));
      items.push({ text: 'ret', fn: h });
      if (withArg) items.push({ text: 'addq $8, %rsp', fn: caller });
      return items;
    },
  },
  {
    id: 'scanf', w: [0, 0, 0, 1.1],
    make: (b) => {
      if (!['rdi', 'rsi', 'rax'].every((r) => b.regs.includes(r))) return null;
      const R = b.R;
      const items = [];
      let rsp = b.rsp, fr = b.frame();
      if (fr < 8) {
        if (rsp - 24 < b.minRsp) return null;
        items.push({ text: 'subq $16, %rsp' });
        rsp -= 16; fr += 16;
      }
      if (rsp - 8 < b.minRsp - 8) return null;
      const addr = rsp + 8 * R.int(0, fr / 8 - 1);
      const input = R.chance(0.3) ? -R.int(1, 50) : R.int(1, 300);
      items.push({ text: R.chance(0.6) ? `leaq ${memText(addr - b.rbp, 'rbp')}, %rsi` : `leaq ${memText(addr - rsp, 'rsp')}, %rsi` });
      items.push({ text: 'movq $format, %rdi' });
      items.push({ text: 'movq $0, %rax' });
      const retSym = b.newRet('call scanf');
      items.push({ text: 'call scanf', meta: { retSym, lib: { name: 'scanf', input: BigInt(input), ret: 1n } }, note: `stdin: you type ${input} ⏎  ·  scanf returns 1 in %rax` });
      if (R.chance(0.6)) {
        const dst = R.pick(b.usable().filter((r) => r !== 'rsi'));
        items.push({ text: addr === rsp && R.chance(0.6) ? `popq %${dst}` : `movq ${memText(addr - b.rbp, 'rbp')}, %${dst}`, allowUnknown: true });
      }
      return items;
    },
  },
  {
    id: 'printf', w: [0, 0, 0, 0.5],
    make: (b) => {
      if (!['rdi', 'rsi', 'rax'].every((r) => b.regs.includes(r)) || b.rsp - 8 < b.minRsp - 8) return null;
      const R = b.R;
      const s = b.frameSlot((c) => c.kind === 'num' && c.v > -1000n && c.v < 100000n, true);
      let srcText, v;
      if (s) { srcText = s.text; v = b.slot(s.addr).v; }
      else {
        const k = b.known().filter((r) => r !== 'rsi' && r !== 'rdi' && b.small(r, 99999n));
        if (!k.length) return null;
        const r = R.pick(k); srcText = `%${r}`; v = b.val(r);
      }
      const out = `${v}\n`;
      const retSym = b.newRet('call printf');
      return [
        { text: 'movq $format, %rdi' },
        { text: `movq ${srcText}, %rsi` },
        { text: 'movq $0, %rax' },
        { text: 'call printf', meta: { retSym, lib: { name: 'printf', out, ret: BigInt(out.length) } }, note: `prints "${v}\\n" · printf returns ${out.length} (characters printed) in %rax` },
      ];
    },
  },
  {
    id: 'memArith', w: [0, 0, 0.6, 1.2],
    make: (b) => {
      const R = b.R;
      const s = b.frameSlot((c) => c.kind === 'num' && c.v > -5000n && c.v < 5000n);
      if (!s) return null;
      const k = b.known().filter((r) => b.small(r, 5000n));
      const opts = [`addq $${R.int(1, 50)}, ${s.text}`, `subq $${R.int(1, 50)}, ${s.text}`];
      if (k.length) {
        const r = R.pick(k);
        opts.push(`addq %${r}, ${s.text}`, `subq %${r}, ${s.text}`, `addq ${s.text}, %${r}`, `subq ${s.text}, %${r}`);
      }
      return [{ text: R.pick(opts) }];
    },
  },
  {
    id: 'mulq', w: [0, 0, 0, 0.7],
    make: (b) => {
      if (!b.regs.includes('rdx') || !b.regs.includes('rax')) return null;
      const R = b.R;
      const items = [];
      if (!b.small('rax', 50n) || b.val('rax') < 0n) items.push({ text: `movq $${R.int(2, 25)}, %rax` });
      const k = b.known().filter((r) => r !== 'rax' && r !== 'rdx' && b.small(r, 20n) && b.val(r) >= 0n);
      if (!k.length) return null;
      items.push({ text: `mulq %${R.pick(k)}` });
      return items;
    },
  },
  {
    id: 'subreg', w: [0, 0, 0, 0.6],
    make: (b) => {
      const R = b.R;
      const k = b.known().filter((r) => LOW8[r]);
      if (!k.length) return null;
      const r = R.pick(k);
      const x = b.val(r);
      if (x < 0n && R.chance(0.7)) return [{ text: `movl $${R.int(1, 999)}, %${LOW32[r]}` }];
      if (x > 255n && R.chance(0.5)) return [{ text: `movb $${R.int(0, 255)}, %${LOW8[r]}` }];
      return [{ text: R.pick([`movb $${R.int(0, 255)}, %${LOW8[r]}`, `movw $${R.int(256, 9999)}, %${LOW16[r]}`, `movl $${R.int(1, 99999)}, %${LOW32[r]}`]) }];
    },
  },
  {
    id: 'movx', w: [0, 0, 0, 0.6],
    make: (b) => {
      const s = b.frameSlot((c) => c.kind === 'num' || c.kind === 'mixed');
      if (!s) return null;
      const bytes = readMem(b.m, s.addr, 8);
      if (!isNum(bytes[0])) return null;
      const kind = b.R.pick(['movzbq', 'movzbq', 'movsbq', 'movzwq']);
      if (kind === 'movzwq' && !isNum(bytes[1])) return null;
      return [{ text: `${kind} ${s.text}, %${b.R.pick(b.usable())}` }];
    },
  },
  {
    id: 'subRspMem', w: [0, 0, 0, 0.5],
    make: (b) => {
      const k = b.R.int(1, 2);
      if (b.rsp - 8 - 8 * k < b.minRsp + 8) return null;
      const items = [{ text: `pushq $${8 * k}` }, { text: 'subq (%rsp), %rsp' }];
      if (b.R.chance(0.5)) items.push({ text: `movq (%rsp), %${b.R.pick(b.usable())}`, allowUnknown: true });
      return items;
    },
  },
];

function pickOp(b) {
  const t = b.tier;
  const avail = OPS.filter((o) => o.w[t] > 0);
  let total = 0;
  for (const o of avail) total += o.w[t];
  let x = b.R.next() * total;
  for (const o of avail) { x -= o.w[t]; if (x <= 0) return o; }
  return avail[avail.length - 1];
}

function genOnce(tier, seed) {
  const R = makeRng(seed);
  const S = R.pick([160, 200, 240, 256, 320, 400, 480, 512, 640, 800, 1000, 1024]);
  const fn = R.pick(FN_NAMES);
  let args;
  if (tier === 0) args = R.pick([['rdi'], ['rdi', 'rsi'], ['rdi', 'rsi']]);
  else if (tier >= 3) args = R.chance(0.4) ? ['rdi', 'rsi', 'rdx'] : ['rdi', 'rsi'];
  else args = R.pick([['rdi', 'rsi'], ['rdi'], ['rdi', 'rsi', 'rdx']]);
  const scratch = ['rax'];
  if (tier >= 1 && R.chance(0.5)) scratch.push(R.pick(['rcx', 'r8', 'rcx']));
  if (tier >= 3 && !args.includes('rdx') && R.chance(0.45)) scratch.push('rdx');
  if (tier >= 3 && !scratch.includes('r8') && R.chance(0.3)) scratch.push('r8');
  const regs = REG_ORDER.filter((r) => args.includes(r) || scratch.includes(r) || r === 'rbp' || r === 'rsp');

  const argVal = () => {
    if (tier === 0) return R.int(1, 30);
    if (tier === 1) return R.int(1, 200);
    if (tier === 2) return R.chance(0.15) ? -R.int(1, 20) : R.int(1, 500);
    return R.chance(0.2) ? -R.int(1, 50) : R.pick([R.int(1, 999), R.int(1, 99), 255, 512, 100]);
  };
  const scratchVal = () => (tier === 0 ? R.int(0, 9) : tier < 2 ? R.int(0, 99) : R.chance(0.2) ? -R.int(1, 30) : R.int(0, 300));
  const regVals = {};
  for (const r of args) regVals[r] = BigInt(argVal());
  for (const r of scratch) regVals[r] = BigInt(scratchVal());
  const syms = baseSyms(fn);
  const m = entryMachine(S, { regs: regVals });
  const notes = [];
  if (tier >= 3 && R.chance(0.45)) {
    const a = S - 8 * R.int(3, 7);
    const v = R.int(1, 99);
    writeMem(m, a, fromBig(BigInt(v)));
    notes.push(`M[${a}] already holds ${v} (left over from earlier code)`);
  }

  const b = new Builder({ R, tier, m, syms, S, fn, regs, scratch, args });
  b.emit('pushq %rbp');
  b.emit('movq %rsp, %rbp');
  const count = [R.int(3, 5), R.int(4, 6), R.int(4, 7), R.int(5, 8)][tier];
  let made = 0, guard = 0;
  // Frames tier+: usually start by allocating locals.
  if (tier >= 1 && R.chance(0.55)) { if (b.tryChunk([{ text: `subq $${R.pick([16, 16, 24, 32])}, %rsp` }])) made++; }
  while (made < count && guard++ < 300) {
    const op = pickOp(b);
    const items = op.make(b);
    if (!items) continue;
    const helperish = op.id === 'helper';
    if (helperish) b.inHelper = true;
    const ok = b.tryChunk(items);
    if (helperish) b.inHelper = false;
    if (ok) made++;
  }
  if (made < Math.min(count, 3)) return null;
  if (tier >= 2 && R.chance(0.5)) b.emit('leave');
  else { b.emit('movq %rbp, %rsp'); b.emit('popq %rbp'); }
  b.emit('ret');
  b.steps.forEach((s, i) => { s.lineNo = i + 1; });
  const argsText = args.map((r) => `${r} = ${regVals[r]}`).join(', ');
  return { kind: 'random', id: `r${seed}`, title: `${fn}`, fn, argsText, notes, tier, regs, syms, S, hi: S + 8, steps: b.steps, init: m };
}

export function generateScenario(tier, seed = (Math.random() * 2 ** 32) >>> 0) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const sc = genOnce(tier, (seed + attempt * 7919) >>> 0);
      if (sc) return sc;
    } catch (e) {
      if (!(e instanceof SimError)) throw e;
    }
  }
  throw new Error('generator failed');
}
