// Compares the player's machine with the truth and figures out *why* they were wrong,
// by replaying the instruction under common wrong mental models ("quirks").

import { exec, readMem, getReg, bytesEq, valText, condOnNumbers, COND_WORDS, regNum, classify } from './sim.js';

export const SPARE_ROWS = 5;

/** Lowest 8-aligned address worth showing for machine m. */
export function lowestInteresting(m) {
  let lo = regNum(m, 'rsp');
  const rbp = regNum(m, 'rbp');
  if (rbp !== null) lo = Math.min(lo, rbp);
  for (const a of m.mem.keys()) lo = Math.min(lo, Math.floor(a / 8) * 8);
  return lo;
}

export function windowLo(m, prevLo = Infinity) {
  return Math.max(0, Math.min(prevLo, lowestInteresting(m) - SPARE_ROWS * 8));
}

export function compare(ans, truth, sc, lo) {
  const diffs = [];
  for (const r of sc.regs) {
    const y = getReg(ans, r), t = getReg(truth, r);
    if (!bytesEq(y, t)) diffs.push({ kind: 'reg', name: r, yours: y, expected: t });
  }
  for (let a = sc.hi; a >= lo; a -= 8) {
    const y = readMem(ans, a, 8), t = readMem(truth, a, 8);
    if (!bytesEq(y, t)) diffs.push({ kind: 'mem', addr: a, yours: y, expected: t });
  }
  return diffs;
}

const QUIRKS = {
  push: ['pushStoreOld', 'pushNoDec', 'pushUp', 'pushNoStore'],
  pop: ['popErase', 'popNoMove', 'popDown', 'popNoReg'],
  mov: ['swap', 'fullWrite', 'bigEndian', 'zextMissing', 'zextExtra'],
  lea: ['leaLoad'],
  add: ['rspWrongDir', 'swap'],
  sub: ['rspWrongDir', 'subRev', 'swap'],
  and: ['swap'], or: ['swap'], xor: ['swap'],
  call: ['callNoPush', 'callNoMove', 'callStoreOld'],
  libcall: ['libNoStale', 'libNoPop', 'libNoInput'],
  ret: ['retNoMove', 'retErase'],
  leave: ['leaveMovOnly', 'leavePopOnly'],
  mul: ['mulNoRdx'],
  movx: ['fullRead', 'signWrong'],
};

export const MSG = {
  pushStoreOld: 'Order matters: `push` decrements %rsp FIRST and then writes at the NEW %rsp. You wrote into the slot %rsp pointed to before — overwriting what was there.',
  pushNoDec: '`push` = two steps: %rsp ← %rsp − 8, then store at the new top. You stored the value but never moved %rsp.',
  pushUp: 'The stack grows DOWN, toward lower addresses: `push` does %rsp ← %rsp − 8, not + 8.',
  pushNoStore: 'You moved %rsp, but `push` also writes the value into the new top slot.',
  popErase: '`pop` does not erase anything: it copies the top value and moves %rsp up by 8. The old value is still in memory — it is just below %rsp now (no longer “on” the stack).',
  popNoMove: '`pop` also moves %rsp UP by 8 (toward higher addresses) after reading.',
  popDown: '`pop` moves %rsp UP (+8) — the stack shrinks toward higher addresses.',
  popNoReg: '`pop` copies the top value into its operand — the destination should change.',
  swap: 'AT&T syntax is `op source, destination`: the destination is the RIGHT operand. You applied it right-to-left.',
  fullWrite: 'The suffix sets the size: `movb` = 1 byte, `movw` = 2, `movl` = 4, `movq` = 8. A 1/2/4-byte write only replaces those bytes — the rest of the 8-byte slot keeps its old (possibly unknown) contents.',
  bigEndian: 'x86-64 is little-endian: the byte at the LOWEST address (offset +0) is the LEAST significant one — the rightmost byte in the slot view. You put it at the wrong end.',
  zextMissing: 'Writing a 32-bit register (%eax, %edi, …) zero-extends: the upper 32 bits of the 64-bit register become 0.',
  zextExtra: 'Writing an 8- or 16-bit register (%al, %ax, …) only changes those bytes — the rest of the register stays as it was.',
  leaLoad: '`lea` computes an address and stores the ADDRESS itself — it never reads memory. (That is exactly the difference with `mov`.)',
  rspWrongDir: '`subq $n, %rsp` moves %rsp DOWN (allocates n bytes); `addq $n, %rsp` moves it UP (frees them).',
  subRev: '`subq src, dst` computes dst ← dst − src (AT&T order): the right operand minus the left one.',
  callNoPush: '`call` = push the return address + jump. %rsp ← %rsp − 8 and the return address goes into that new top slot.',
  callNoMove: '`call` pushes the return address, so %rsp must move down by 8 as well.',
  callStoreOld: '`call` pushes like `push`: first %rsp ← %rsp − 8, then the return address is written at the NEW %rsp.',
  libNoStale: 'Even though the function already returned, its `call` pushed a return address at %rsp − 8 and its `ret` only moved %rsp back up. That return address is still in memory below %rsp — this is exactly how 368 got overwritten in the 2025 midterm.',
  libNoPop: 'The library function returns before the next line runs: its `ret` pops the return address, so %rsp is back where it was before the call.',
  libNoInput: '`scanf` stores the number it reads at the address you passed in %rsi.',
  retNoMove: '`ret` pops the return address into %rip, so %rsp moves up by 8.',
  retErase: '`ret` does not erase the return address — it only moves %rsp up.',
  leaveMovOnly: '`leave` = `movq %rbp, %rsp` AND `popq %rbp`. You only did the first half.',
  leavePopOnly: '`leave` first does `movq %rbp, %rsp`, then `popq %rbp`. You popped from the wrong place.',
  fullRead: '`movzbq` / `movsbq` read only ONE byte (the `b`) and then extend it to 8 bytes (the `q`). The other 7 bytes of the slot are ignored — even if they are garbage.',
  signWrong: '`movz…` zero-extends (the new bytes are 0); `movs…` sign-extends (the new bytes copy the top bit, so a byte ≥ 128 becomes negative).',
  mulNoRdx: '`mulq src` multiplies %rax by src into the 128-bit pair %rdx:%rax — %rdx gets the high 64 bits (0 for small numbers).',
};

function quirksFor(step) {
  if (step.ins.op === 'call' && step.meta.lib) return QUIRKS.libcall;
  return QUIRKS[step.ins.op] || [];
}

const locKey = (d) => (d.kind === 'reg' ? 'r:' + d.name : 'm:' + d.addr);
function locValue(m, d) { return d.kind === 'reg' ? getReg(m, d.name) : readMem(m, d.addr, 8); }

export function diagnose(step, ans, sc, lo) {
  const diffs = compare(ans, step.after, sc, lo);
  const explained = new Set();
  const hits = [];
  for (const q of quirksFor(step)) {
    let v;
    try { v = exec(step.before, step.ins, { syms: sc.syms, meta: step.meta, quirk: q }); } catch { continue; }
    const qd = compare(v.m, step.after, sc, lo);
    if (!qd.length) continue; // this wrong model gives the right answer here → not diagnostic
    let n = 0;
    for (const d of diffs) {
      if (bytesEq(locValue(v.m, d), d.yours) && !bytesEq(d.yours, d.expected)) { n++; }
    }
    const exact = compare(ans, v.m, sc, lo).length === 0;
    if (n > 0) hits.push({ q, n, exact, keys: diffs.filter((d) => bytesEq(locValue(v.m, d), d.yours)).map(locKey) });
  }
  hits.sort((a, b) => (b.exact - a.exact) || (b.n - a.n));
  const mistakes = [];
  for (const h of hits) {
    if (mistakes.length >= 2) break;
    if (h.keys.every((k) => explained.has(k))) continue;
    h.keys.forEach((k) => explained.add(k));
    mistakes.push(MSG[h.q]);
  }
  for (const d of diffs) d.note = diffNote(d, step, sc);
  return { diffs, mistakes };
}

function diffNote(d, step, sc) {
  const V = (b) => valText(b, sc.syms);
  const before = d.kind === 'reg' ? getReg(step.before, d.name) : readMem(step.before, d.addr, 8);
  const unchangedTruth = bytesEq(before, d.expected);
  const unchangedYours = bytesEq(before, d.yours);
  if (d.kind === 'reg') {
    if (unchangedTruth) return 'this register is not touched by this instruction';
    if (unchangedYours) return `this instruction changes it (from ${V(before)})`;
    return '';
  }
  if (unchangedTruth && classify(d.yours).kind === 'unk') return 'nothing erased it — memory keeps its value until something overwrites it';
  if (unchangedTruth) return 'this slot is not written by this instruction';
  if (unchangedYours) return `this slot gets written (it held ${V(before)})`;
  if (classify(d.expected).kind === 'mixed') return 'only some bytes change here — look at the byte view';
  return '';
}

export function diagnoseBranch(step, choice) {
  const truth = step.info.branch.taken;
  const c = step.before.cmp;
  const mistakes = [];
  const [word, sym] = COND_WORDS[step.ins.cond] || ['?', '?'];
  if (c && c.x !== null && c.y !== null) {
    const flipped = condOnNumbers(step.ins.cond, c.y, c.x);
    if (flipped === choice && flipped !== truth) {
      mistakes.push(`Operand-order trap: \`cmp ${c.src}, ${c.dst}\` compares ${c.dst} against ${c.src} (it computes ${c.dst} − ${c.src}). So \`${step.ins.mnem}\` asks “is ${c.dst} ${sym} ${c.src}?”, i.e. ${c.x} ${sym} ${c.y} — not the other way around.`);
    } else {
      mistakes.push(`\`${step.ins.mnem}\` = jump if ${word}. With the last \`cmp\` that asks: is ${c.x} ${sym} ${c.y}? → ${truth ? 'yes' : 'no'}.`);
    }
  }
  return { diffs: [], mistakes };
}
