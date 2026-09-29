// node test/run.mjs — sanity checks for the simulator, the generator and the mistake detector.
import assert from 'node:assert/strict';
import { parse, exec, readMem, getReg, valText, classify, clone, bytesEq, fromBig, writeMem, setReg } from '../src/sim.js';
import { buildPaper } from '../src/papers.js';
import { generateScenario, createEndless, tierForScore } from '../src/gen.js';
import { compare, diagnose, diagnoseBranch, windowLo, MSG } from '../src/feedback.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (e) { console.error('✗', name); throw e; }
};
const slot = (m, a, syms) => valText(readMem(m, a, 8), syms);

// ── parser ──
test('parser', () => {
  const p = parse('  leaq (%rbp, %r12, 1), %rsi  # comment');
  assert.equal(p.op, 'lea');
  assert.equal(p.operands[0].index, 'r12');
  assert.equal(parse('movb $32, 8(%rsp)').size, 1);
  assert.equal(parse('push %rbp').size, 8);
  assert.equal(parse('shll $2, %eax').op, 'shl');
  assert.equal(parse('jl calculation').cond, 'l');
  assert.equal(parse('mull %esi').op, 'mul');
  assert.equal(parse('calculation:').empty, true);
});

// ── past papers reproduce the official answer keys ──
test('2024 blinds', () => {
  const sc = buildPaper('2024');
  const at19 = sc.steps.find((s) => s.lineNo === 19).before;
  const want = { 392: 'old rbp', 384: '5', 376: '2', 368: '[? ? ? ? ? ? ? 32]', 360: '512', 352: '2' };
  for (const [a, v] of Object.entries(want)) assert.equal(slot(at19, +a, sc.syms), v, `M[${a}]`);
  assert.equal(valText(getReg(at19, 'rsp'), sc.syms), '352');
  assert.equal(sc.steps.find((s) => s.lineNo === 14).info.branch.taken, false);
  assert.equal(sc.steps.at(-1).text, 'ret');
});
test('2025 scanf', () => {
  const sc = buildPaper('2025');
  const m = sc.steps.at(-1).after;
  assert.equal(slot(m, 392, sc.syms), 'old rbp');
  assert.equal(slot(m, 384, sc.syms), '16');
  assert.equal(slot(m, 376, sc.syms), 'ret₂');
  assert.equal(slot(m, 368, sc.syms), '?');
  assert.equal(valText(getReg(m, 'rsp'), sc.syms), '368');
  assert.equal(valText(getReg(m, 'rbp'), sc.syms), '392');
  assert.equal(valText(getReg(m, 'r12'), sc.syms), '-8');
});

// ── sub-register semantics ──
test('movzbq / movsbq', () => {
  const sc = buildPaper('2024');
  let m = clone(sc.init);
  writeMem(m, 368, [200, null, null, null, null, null, null, null]);
  m = exec(m, parse('movzbq 368, %rax')).m;
  assert.equal(valText(getReg(m, 'rax')), '200');
  m = exec(m, parse('movsbq 368, %rax')).m;
  assert.equal(valText(getReg(m, 'rax')), '-56');
});

test('subregs', () => {
  const sc = buildPaper('2024');
  let m = clone(sc.init);
  setReg(m, 'rax', fromBig(-5n));
  m = exec(m, parse('movl $7, %eax')).m;
  assert.equal(valText(getReg(m, 'rax')), '7');
  setReg(m, 'rax', fromBig(300n));
  m = exec(m, parse('movb $1, %al')).m;
  assert.equal(valText(getReg(m, 'rax')), '257');
});

// ── generator fuzz + invariants ──
const opCount = {};
for (let tier = 0; tier < 4; tier++) {
  test(`generator tier ${tier}`, () => {
    let totalSteps = 0, branches = 0;
    for (let i = 0; i < 1500; i++) {
      const sc = generateScenario(tier, 1000 + i * 31 + tier);
      assert.ok(sc.steps.length >= 5, 'too short');
      assert.equal(sc.steps.at(-1).text, 'ret');
      assert.equal(sc.steps.at(-1).info.ret, 'ret0');
      let lo = Infinity;
      for (const st of sc.steps) {
        totalSteps++;
        lo = windowLo(st.before, lo);
        const key = st.ins.mnem + (st.meta.lib ? ' ' + st.meta.lib.name : '');
        opCount[key] = (opCount[key] || 0) + 1;
        // every change of truth must be visible in the window
        const changed = [...new Set([...st.before.mem.keys(), ...st.after.mem.keys()])].filter((a) => st.before.mem.get(a) !== st.after.mem.get(a));
        for (const a of changed) assert.ok(a >= lo && a < sc.hi + 8, `change at ${a} outside window [${lo}, ${sc.hi}] in ${sc.title} step ${st.lineNo} ${st.text}`);
        if (st.ins.op === 'jcc') { branches++; assert.ok(st.info.branch); }
        for (const r of sc.regs) assert.equal(getReg(st.after, r).length, 8);
        // rsp is always 8-aligned and numeric
        const rsp = classify(getReg(st.after, 'rsp'));
        assert.equal(rsp.kind, 'num');
        assert.equal(Number(rsp.v) % 8, 0);
      }
    }
    console.log(`  tier ${tier}: avg ${(totalSteps / 1500).toFixed(1)} steps/routine, ${branches} branches`);
  });
}

// ── mistake detection: feeding a quirk's result back must name that quirk ──
test('quirk detection', () => {
  const hits = {};
  for (let i = 0; i < 400; i++) {
    const sc = generateScenario(i % 4, 777 + i);
    let lo = Infinity;
    for (const st of sc.steps) {
      lo = windowLo(st.before, lo);
      if (st.info.branch) continue;
      const truthDiff = compare(st.after, st.after, sc, lo);
      assert.equal(truthDiff.length, 0);
      const ok = diagnose(st, st.after, sc, lo);
      assert.equal(ok.diffs.length, 0);
      for (const q of Object.keys(MSG)) {
        let v;
        try { v = exec(st.before, st.ins, { syms: sc.syms, meta: st.meta, quirk: q }); } catch { continue; }
        if (!compare(v.m, st.after, sc, lo).length) continue;
        const d = diagnose(st, v.m, sc, lo);
        if (d.mistakes.length === 0) continue;
        if (d.mistakes.includes(MSG[q])) hits[q] = (hits[q] || 0) + 1;
      }
    }
  }
  for (const q of ['pushStoreOld', 'pushUp', 'popErase', 'popNoMove', 'swap', 'fullWrite', 'bigEndian', 'leaLoad', 'rspWrongDir', 'callNoPush', 'libNoStale', 'retNoMove', 'leaveMovOnly']) {
    assert.ok(hits[q] > 0, `quirk ${q} never detected`);
  }
});

// ── regressions from the semantics audit ──
test('audit regressions', () => {
  const base = () => { const mm = clone(buildPaper('2024').init); return mm; };
  const run = (m, line) => exec(m, parse(line)).m;
  const R = (m, r) => valText(getReg(m, r));
  const J = (m, line) => exec(m, parse(line)).info.branch.taken;
  let m = base();
  setReg(m, 'rax', fromBig(-1n)); setReg(m, 'rsi', fromBig(2n));
  let a = run(m, 'mulq %rsi'); assert.equal(R(a, 'rdx'), '1'); assert.equal(R(a, 'rax'), '-2');
  a = run(m, 'imulq %rsi'); assert.equal(R(a, 'rdx'), '-1'); assert.equal(R(a, 'rax'), '-2');
  m = base(); setReg(m, 'rax', [null, null, null, null, null, null, null, null]);
  a = run(m, 'xorq %rax, %rax'); assert.equal(R(a, 'rax'), '0'); assert.equal(J(a, 'je x'), true);
  m = base(); setReg(m, 'rax', fromBig((1n << 63n) - 1n));
  a = run(m, 'incq %rax'); assert.equal(J(a, 'jl x'), false);
  m = base(); setReg(m, 'rax', fromBig(5n));
  a = run(m, 'negq %rax'); assert.equal(J(a, 'jb x'), true);
  m = base(); setReg(m, 'rax', fromBig(1n));
  a = run(run(m, 'cmpq $2, %rax'), 'incq %rax'); assert.equal(J(a, 'jae x'), false);
  m = base(); setReg(m, 'rax', fromBig(5n));
  a = run(run(m, 'cmpq $9, %rax'), 'shrq $3, %rax'); assert.equal(J(a, 'je x'), true);
  m = base(); setReg(m, 'rax', fromBig(1n));
  assert.equal(R(run(m, 'shll $33, %eax'), 'rax'), '2');
  assert.throws(() => run(m, 'divl %ecx'));
  m = base(); setReg(m, 'rdx', fromBig(5n)); setReg(m, 'rax', fromBig(0n)); setReg(m, 'rcx', fromBig(2n));
  assert.throws(() => run(m, 'divq %rcx'));
  for (const bad of ['pushw $1', 'popw %ax', 'pushq %eax', 'movq %eax, %rbx', 'movl $format, 8(%rsp)', 'mov $5, 8(%rsp)', 'inc 8(%rsp)']) {
    assert.throws(() => parse(bad), undefined, bad);
  }
  m = base();
  assert.equal(R(run(m, 'leaq -500(%rsp), %rdx'), 'rdx'), '-100');
});

test('no reliance on caller-saved registers after library calls', () => {
  const CALLER = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9', 'r10', 'r11'];
  let calls = 0;
  for (let i = 0; i < 1500; i++) {
    const sc = generateScenario(3, 90000 + i);
    const clob = new Set();
    for (const st of sc.steps) {
      const ops = st.ins.operands;
      const dst = ops[ops.length - 1];
      const pure = (['mov', 'movx', 'lea', 'pop'].includes(st.ins.op) && dst && dst.t === 'reg' && dst.size >= 4)
        || (st.ins.op === 'xor' && ops[0].t === 'reg' && dst.t === 'reg' && ops[0].name === dst.name);
      const reads = [];
      ops.forEach((o, k) => {
        if (o.t === 'reg' && !(pure && k === ops.length - 1)) reads.push(o.base || o.name);
        if (o.t === 'mem') { if (o.base) reads.push(o.base); if (o.index) reads.push(o.index); }
      });
      if (st.ins.op === 'mul' || (st.ins.op === 'imul' && ops.length === 1)) reads.push('rax');
      if (st.ins.op === 'call' && st.meta.lib && st.meta.lib.name === 'scanf') reads.push('rsi');
      for (const r of reads) assert.ok(!clob.has(r), `${sc.title}: step ${st.lineNo} "${st.text}" reads %${r} after a library call clobbered it`);
      if (st.ins.op === 'call' && st.meta.lib) { calls++; CALLER.forEach((r) => clob.add(r)); }
      else if (pure) clob.delete(dst.base);
      else if (st.ins.op === 'mul' || (st.ins.op === 'imul' && ops.length === 1)) { clob.delete('rax'); clob.delete('rdx'); }
    }
  }
  assert.ok(calls > 100);
});

test('endless: one main, never an epilogue', () => {
  for (let run = 0; run < 12; run++) {
    const sc = createEndless(4242 + run * 17);
    let score = 0;
    while (sc.steps.length < 800) { score = sc.steps.length; sc.extend(tierForScore(score)); }
    const main = sc.steps.filter((st) => st.fn === 'main');
    assert.equal(main.filter((st) => st.text === 'pushq %rbp').length, 1, 'exactly one main prologue');
    assert.equal(sc.steps[0].text, 'pushq %rbp');
    assert.equal(sc.steps[1].text, 'movq %rsp, %rbp');
    for (const st of main.slice(2)) {
      assert.ok(!['ret', 'leave', 'popq %rbp', 'movq %rbp, %rsp'].includes(st.text), `main epilogue-ish step: ${st.text} (line ${st.lineNo})`);
    }
    assert.ok(sc.steps.every((st) => st.info.ret !== 'ret0'), 'main never returns');
    // helpers still get full frames
    const helperRets = sc.steps.filter((st) => st.fn !== 'main' && st.text === 'ret').length;
    const calls = sc.steps.filter((st) => st.ins.op === 'call' && !st.meta.lib).length;
    assert.equal(helperRets, calls);
    // unique labels / function names
    const labels = sc.steps.map((st) => st.label).filter(Boolean);
    assert.equal(new Set(labels).size, labels.length, 'labels unique');
    // window & bounds
    let lo = Infinity, deep = 0;
    sc.steps.forEach((st, i) => {
      assert.equal(st.lineNo, i + 1);
      lo = windowLo(st.before, lo);
      const changed = [...new Set([...st.before.mem.keys(), ...st.after.mem.keys()])].filter((a) => st.before.mem.get(a) !== st.after.mem.get(a));
      for (const a of changed) assert.ok(a >= lo && a < sc.hi + 8, `change at ${a} outside window`);
      const rsp = Number(classify(getReg(st.after, 'rsp')).v);
      assert.ok(rsp >= sc.S - 96 && rsp <= sc.S, `rsp ${rsp} out of bounds`);
      if (sc.S - 8 - rsp >= 8 * 10) deep++;
    });
    assert.ok(deep / sc.steps.length < 0.5, `stack pinned deep ${deep}/${sc.steps.length}`);
    assert.ok(sc.tier === 3);
  }
});

test('branch diagnosis', () => {
  const sc = buildPaper('2024');
  const jl = sc.steps.find((s) => s.ins.op === 'jcc');
  const d = diagnoseBranch(jl, true);
  assert.match(d.mistakes[0], /Operand-order trap/);
});

console.log(`\n${passed} test groups passed.`);
console.log('instruction mix:', Object.entries(opCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '));
