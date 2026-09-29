// Turns instructions into "steps": the unit the player solves.
// A step knows the machine state before/after, the explanation and branch/call info.

import { parse, exec, SimError, symBytes, machine, setReg, fromBig, writeMem, unk } from './sim.js';

export function makeStep(before, item, syms) {
  const ins = item.ins || parse(item.text);
  if (ins.empty) throw new SimError('empty line');
  const res = exec(before, ins, { syms, meta: item.meta || {} });
  return {
    text: ins.text,
    ins,
    meta: item.meta || {},
    note: item.note || null,
    label: item.label || null,
    lineNo: item.lineNo ?? null,
    fn: item.fn || null,
    skipped: item.skipped || null,
    checkpoint: item.checkpoint || null,
    before,
    after: res.m,
    explain: res.steps,
    info: res.info,
  };
}

/** Standard symbols every routine starts with. */
export function baseSyms(fn) {
  return {
    rbp0: { label: 'old rbp', kind: 'rbp', desc: `the caller's base pointer — whatever %rbp held when ${fn} started` },
    ret0: { label: 'ret₀', kind: 'ret', desc: `return address back into the code that called ${fn}` },
    '&format': { label: '&format', kind: 'label', desc: 'address of the format string (a label in .data/.text)' },
  };
}

/** Fresh machine for a routine entered with %rsp = S. */
export function entryMachine(S, { ret0 = true, regs = {} } = {}) {
  const m = machine();
  setReg(m, 'rsp', fromBig(S));
  setReg(m, 'rbp', symBytes('rbp0'));
  if (ret0) writeMem(m, S, symBytes('ret0'));
  for (const [r, v] of Object.entries(regs)) setReg(m, r, v === null ? unk() : fromBig(v));
  return m;
}

/**
 * Execute a full listing (exam style), following jumps, calls and returns.
 * lineMeta: { [lineNo]: { meta, note, checkpoint } }
 */
export function runListing(source, { init, syms, lineMeta = {}, start = null, fn = null, maxSteps = 300 }) {
  const lines = source.replace(/\r/g, '').split('\n');
  const parsed = lines.map((l) => parse(l));
  const labels = {};
  parsed.forEach((p, i) => { if (p.label) labels[p.label] = i; });
  let pc = start !== null ? labels[start] : 0;
  let m = init;
  const steps = [];
  let pendingLabel = null;
  const returnTo = {};
  let retN = 0;
  const fnStack = [fn];
  while (pc < lines.length && steps.length < maxSteps) {
    const p = parsed[pc];
    if (p.label) pendingLabel = p.label;
    if (p.empty) { pc++; continue; }
    const lineNo = pc + 1;
    const lm = lineMeta[lineNo] || {};
    const meta = { ...(lm.meta || {}) };
    if (p.op === 'call' && !meta.retSym) {
      retN++;
      meta.retSym = `ret${retN}`;
      if (!syms[meta.retSym]) syms[meta.retSym] = { label: `ret${'₀₁₂₃₄₅₆₇₈₉'[retN] || retN}`, kind: 'ret', desc: `return address pushed by \`${p.text}\` (line ${lineNo})` };
    }
    const st = makeStep(m, { ins: p, meta, note: lm.note, label: pendingLabel, lineNo, fn: fnStack[fnStack.length - 1], checkpoint: lm.checkpoint }, syms);
    pendingLabel = null;
    steps.push(st);
    m = st.after;
    const info = st.info;
    if (info.branch && info.branch.taken) {
      const target = labels[info.branch.target];
      if (target === undefined) throw new SimError(`unknown label ${info.branch.target}`);
      if (target > pc) st.skipped = parsed.slice(pc + 1, target).filter((x) => !x.empty).map((x) => x.text);
      pc = target;
      continue;
    }
    if (info.call && !info.call.lib) {
      const target = labels[info.call.target];
      if (target === undefined) throw new SimError(`unknown label ${info.call.target}`);
      returnTo[meta.retSym] = pc + 1;
      fnStack.push(info.call.target);
      pc = target;
      continue;
    }
    if (st.ins.op === 'ret') {
      if (info.ret && returnTo[info.ret] !== undefined) { pc = returnTo[info.ret]; fnStack.pop(); continue; }
      break; // returned out of the routine
    }
    pc++;
  }
  return steps;
}
