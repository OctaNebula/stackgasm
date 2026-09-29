// Game state + actions. The UI re-renders whenever `onChange` fires.

import { clone, writeMem, readMem, getReg, fromBig, unk, symBytes, regNum, bytesEq, classify } from './sim.js';
import { generateScenario, createEndless, tierForScore, TIERS } from './gen.js';
import { buildPaper, PAPERS } from './papers.js';
import { compare, diagnose, diagnoseBranch, windowLo } from './feedback.js';
import { sound } from './sound.js';

const store = {
  get(k, d) {
    try { const v = localStorage.getItem('stackgasm.' + k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('stackgasm.' + k, JSON.stringify(v)); } catch { /* private mode etc. */ }
  },
};

// Mnemonics that never get a "NEW" badge.
const BASICS = ['pushq', 'push', 'popq', 'movq', 'mov', 'ret', 'addq', 'subq'];

const SUBDIG = '₀₁₂₃₄₅₆₇₈₉';
const norm = (s) => s.toLowerCase().replace(/[\s_⮐]/g, '').replace(/[₀-₉]/g, (d) => String(SUBDIG.indexOf(d)));

export class Game {
  constructor(onChange) {
    this.onChange = onChange;
    this.prefs = Object.assign({ mode: 'endless', difficulty: 'auto', paper: '2024', hex: false, sound: true }, store.get('prefs', {}));
    this.best = store.get('best', 0);
    this.ui = { sel: null, edit: null, editId: 0, expanded: new Set(), view: 'yours', ptrPreview: null, ref: false, toast: null };
    sound.enabled = this.prefs.sound;
    this.start(this.prefs.mode);
    if (!store.get('introSeen', false)) {
      store.set('introSeen', true);
      setTimeout(() => this.toast('Make the right side look like the machine AFTER the instruction, then press Enter. Press F1 for the cheat sheet and all controls.', 'tier', 9000), 600);
    }
  }

  emit() { this.onChange(); }
  savePrefs() { store.set('prefs', this.prefs); }

  // ───────────── modes & flow ─────────────
  start(mode) {
    clearTimeout(this._t);
    this.prefs.mode = mode;
    this.savePrefs();
    this.mode = mode;
    this.score = 0;
    this.streak = 0;
    this.mistakes = 0;
    this.routines = 0;
    this.seen = new Set(BASICS);
    this.lastTier = null;
    this.newBest = false;
    this.nextScenario();
  }

  setDifficulty(d) { this.prefs.difficulty = d; this.savePrefs(); this.start('practice'); }
  setPaper(id) { this.prefs.paper = id; this.savePrefs(); this.start('papers'); }
  toggleHex() { this.prefs.hex = !this.prefs.hex; this.savePrefs(); this.emit(); }
  toggleSound() { this.prefs.sound = !this.prefs.sound; sound.enabled = this.prefs.sound; this.savePrefs(); this.emit(); }
  toggleRef(v) { this.ui.ref = v === undefined ? !this.ui.ref : v; this.emit(); }

  currentTier() {
    if (this.mode === 'practice' && this.prefs.difficulty !== 'auto') return Number(this.prefs.difficulty);
    return tierForScore(this.score);
  }

  nextScenario() {
    clearTimeout(this._t);
    if (this.mode === 'papers') {
      this.scenario = buildPaper(this.prefs.paper);
    } else if (this.mode === 'endless') {
      // Endless = one main that never returns: prologue once, then the body is generated on the fly.
      this.scenario = createEndless();
      this.lastTier = 0;
    } else {
      const t = this.currentTier();
      this.scenario = generateScenario(t);
      if (this.lastTier !== null && t > this.lastTier) this.toast(`Tier ${t + 1} unlocked — ${TIERS[t].name}: ${TIERS[t].desc}`, 'tier', 4200);
      this.lastTier = t;
    }
    this.stepIdx = 0;
    this.lo = Infinity;
    this.ui.expanded = new Set();
    this.beginStep();
  }

  get step() { return this.scenario.steps[this.stepIdx]; }

  beginStep() {
    const st = this.step;
    this.lo = windowLo(st.before, this.lo);
    this.answer = clone(st.before);
    this.undoStack = [];
    this.choice = null;
    this.feedback = null;
    this.phase = 'play';
    this.ui.view = 'yours';
    this.ui.edit = null;
    this.ui.sel = null;
    this.ui.ptrPreview = null;
    const key = st.ins.mnem + (st.meta.lib ? ' ' + st.meta.lib.name : '');
    this.isNew = this.mode !== 'papers' && !this.seen.has(key);
    this.seen.add(key);
    this.emit();
  }

  get isBranch() { return !!(this.step && this.step.info.branch); }
  canEdit() { return this.phase === 'play' && !this.isBranch; }

  check() {
    if (this.phase !== 'play') return;
    const st = this.step, sc = this.scenario;
    let ok, fb = null;
    if (this.isBranch) {
      if (this.choice === null) { this.toast('Decide first: jump taken (T) or not taken (N)?', 'warn'); return; }
      ok = this.choice === st.info.branch.taken;
      if (!ok) fb = diagnoseBranch(st, this.choice);
    } else {
      ok = compare(this.answer, st.after, sc, this.lo).length === 0;
      if (!ok) fb = diagnose(st, this.answer, sc, this.lo);
    }
    this.ui.edit = null;
    this.ui.sel = null;
    if (ok) {
      this.score++;
      this.streak++;
      if (this.mode === 'endless' && this.score > this.best) {
        this.best = this.score;
        store.set('best', this.best);
        this.newBest = true;
      }
      sound.ok(this.streak);
      this.phase = 'ok';
      this.emit();
      clearTimeout(this._t);
      this._t = setTimeout(() => this.advance(), 430);
    } else {
      sound.bad();
      this.mistakes++;
      this.feedback = fb;
      this.phase = this.mode === 'endless' ? 'dead' : 'wrong';
      this.emit();
    }
  }

  choose(taken) {
    if (this.phase !== 'play' || !this.isBranch) return;
    this.choice = taken;
    this.check();
  }

  /** Endless: keep a few steps generated ahead of the player, at the tier their score has reached. */
  ensureSteps() {
    const sc = this.scenario;
    if (!sc.endless) return;
    while (sc.steps.length - this.stepIdx <= 4) {
      const t = tierForScore(this.score);
      if (t > sc.tier) this.toast(`Tier ${t + 1} unlocked — ${TIERS[t].name}: ${TIERS[t].desc}`, 'tier', 4200);
      sc.extend(t);
    }
  }

  advance() {
    this.ensureSteps();
    if (this.stepIdx + 1 >= this.scenario.steps.length) { this.routineDone(); return; }
    this.stepIdx++;
    this.beginStep();
  }

  routineDone() {
    this.routines++;
    sound.done();
    this.answer = clone(this.step.after);
    if (this.mode === 'papers') { this.phase = 'paperDone'; this.emit(); return; }
    this.phase = 'routineDone';
    this.emit();
    clearTimeout(this._t);
    this._t = setTimeout(() => { if (this.phase === 'routineDone') this.nextScenario(); }, 1800);
  }

  /** Enter key / primary button. */
  primary() {
    switch (this.phase) {
      case 'play': this.check(); break;
      case 'wrong': this.streak = 0; this.advance(); break;
      case 'dead': this.start(this.mode); break;
      case 'routineDone': this.nextScenario(); break;
      case 'paperDone': this.nextScenario(); break;
      default: break;
    }
  }

  setView(v) { this.ui.view = v; this.emit(); }

  // ───────────── editing the answer ─────────────
  edit(fn) {
    if (!this.canEdit()) return false;
    const before = clone(this.answer);
    fn(this.answer);
    if (sameMachine(before, this.answer, this.scenario, this.lo)) { this.emit(); return false; }
    this.undoStack.push(before);
    if (this.undoStack.length > 300) this.undoStack.shift();
    sound.tick();
    this.emit();
    return true;
  }
  setSlot(addr, bytes) { return this.edit((m) => writeMem(m, addr, bytes)); }
  setByte(addr, b) { return this.edit((m) => writeMem(m, addr, [b])); }
  setRegBytes(name, bytes) { return this.edit((m) => { m.regs[name] = bytes.slice(0, 8); }); }
  movePtr(name, addr) {
    addr = Math.max(this.lo, Math.min(this.scenario.hi, addr));
    return this.setRegBytes(name, fromBig(BigInt(addr)));
  }
  nudgePtr(name, delta) {
    if (!this.canEdit()) return;
    const v = regNum(this.answer, name);
    const next = v === null ? regNum(this.answer, 'rsp') : v + delta;
    this.movePtr(name, next);
    if (name === 'rsp') this.ui.sel = { kind: 'mem', addr: Math.max(this.lo, Math.min(this.scenario.hi, next)) };
    this.emit();
  }
  undo() {
    if (!this.canEdit() || !this.undoStack.length) return;
    this.answer = this.undoStack.pop();
    this.ui.edit = null;
    this.emit();
  }
  reset() {
    if (!this.canEdit()) return;
    this.undoStack.push(clone(this.answer));
    this.answer = clone(this.step.before);
    this.ui.edit = null;
    this.emit();
  }
  toggleExpand(addr) {
    const s = this.ui.expanded;
    if (s.has(addr)) s.delete(addr); else s.add(addr);
    this.emit();
  }

  select(target) { this.ui.sel = target; this.emit(); }
  selectPtr(name) {
    if (!this.canEdit()) return;
    this.ui.sel = this.ui.sel && this.ui.sel.kind === 'ptr' && this.ui.sel.name === name ? null : { kind: 'ptr', name };
    this.ui.edit = null;
    this.emit();
  }
  previewPtr(name, addr) {
    const p = addr === null ? null : { name, addr };
    const cur = this.ui.ptrPreview;
    if ((cur && p && cur.name === p.name && cur.addr === p.addr) || (!cur && !p)) return;
    this.ui.ptrPreview = p;
    this.emit();
  }

  startEdit(target, initText = null) {
    if (!this.canEdit()) return;
    this.ui.editId++;
    this.ui.edit = { ...target, id: this.ui.editId, init: initText };
    this.ui.sel = target.kind === 'byte' ? { kind: 'mem', addr: Math.floor(target.addr / 8) * 8 } : target;
    this.emit();
  }
  cancelEdit() { this.ui.edit = null; this.emit(); }

  /** Returns true if the edit closed. */
  commitEdit(id, text, { fromBlur = false } = {}) {
    const e = this.ui.edit;
    if (!e || e.id !== id) return true;
    const size = e.kind === 'byte' ? 1 : 8;
    const bytes = this.parseValue(text, size);
    if (bytes === null) { this.ui.edit = null; this.emit(); return true; }
    if (bytes === undefined) {
      if (fromBlur) { this.ui.edit = null; this.emit(); return true; }
      const hint = /\s/.test(String(text).trim()) ? 'a byte list needs exactly 8 bytes, most significant first (e.g. "? ? ? ? ? ? ? 32" or "XXXXXXX 32")'
        : norm(String(text)) === 'ret' ? 'which return address? type ret0, ret1, … (or use the chips)'
        : 'type a number (−8, 0x1f), ? for unknown, a symbol like “old rbp”, or 8 bytes like “XXXXXXX 32”';
      this.toast(`Can't read “${text}” — ${hint}`, 'warn', 4200);
      return false;
    }
    this.ui.edit = null;
    if (e.kind === 'mem') this.setSlot(e.addr, bytes);
    else if (e.kind === 'byte') this.setByte(e.addr, bytes[0]);
    else if (e.kind === 'reg') this.setRegBytes(e.name, bytes);
    this.emit();
    return true;
  }

  /** Move the editor to a neighbouring cell (arrow keys inside an input). */
  editNeighbor(dir) {
    const e = this.ui.sel;
    if (!e) return;
    if (e.kind === 'mem') {
      const addr = e.addr + (dir < 0 ? 8 : -8);
      if (addr > this.scenario.hi || addr < this.lo) return;
      this.startEdit({ kind: 'mem', addr });
    } else if (e.kind === 'reg') {
      const regs = this.scenario.regs;
      const i = regs.indexOf(e.name) + dir;
      if (i < 0 || i >= regs.length) return;
      this.startEdit({ kind: 'reg', name: regs[i] });
    }
  }
  moveSel(dir) {
    const s = this.ui.sel;
    if (!s) return;
    if (s.kind === 'ptr') { this.nudgePtr(s.name, dir < 0 ? 8 : -8); this.ui.sel = s; this.emit(); return; }
    if (s.kind === 'mem') {
      const addr = s.addr + (dir < 0 ? 8 : -8);
      if (addr <= this.scenario.hi && addr >= this.lo) this.select({ kind: 'mem', addr });
    } else if (s.kind === 'reg') {
      const regs = this.scenario.regs;
      const i = regs.indexOf(s.name) + dir;
      if (i >= 0 && i < regs.length) this.select({ kind: 'reg', name: regs[i] });
    }
  }
  clearSel() {
    if (!this.ui.sel || !this.canEdit()) return;
    const s = this.ui.sel;
    if (s.kind === 'mem') this.setSlot(s.addr, unk());
    else if (s.kind === 'reg') this.setRegBytes(s.name, unk());
  }

  parseValue(text, size) {
    const s = String(text).trim();
    if (s === '') return null;
    if (size === 1 ? /^[?xX]+$/.test(s) : /^[?xX]$|^\?\?$/.test(s)) return unk(size);
    // Exam-style byte list, most significant byte first: "? ? ? ? ? ? ? 32" or "XXXXXXX 32"
    if (size === 8 && /\s/.test(s) || (size === 8 && /^[?xX]{2,}/.test(s))) {
      const list = this.parseByteList(s);
      if (list) return list;
    }
    if (size === 8) {
      const n = norm(s);
      if (n === 'ret') {
        const rets = this.palette().filter((id) => this.scenario.syms[id].kind === 'ret');
        if (this.step.meta.retSym) return symBytes(this.step.meta.retSym);
        if (rets.length === 1) return symBytes(rets[0]);
        return undefined;
      }
      const alts = [n, n.replace(/^\$/, '&'), '&' + n];
      for (const [id, sy] of Object.entries(this.scenario.syms)) {
        if (alts.includes(norm(sy.label)) || norm(id) === n || (sy.kind === 'rbp' && ['rbp', 'oldrbp', 'rbp0'].includes(n))) return symBytes(id);
      }
    }
    let t = s.replace(/_/g, '').replace(/[−–]/g, '-').replace(/^-\s+/, '-');
    if (/\s/.test(t)) return undefined;
    let neg = false;
    if (t.startsWith('-')) { neg = true; t = t.slice(1); }
    let v;
    if (/^0x[0-9a-f]+$/i.test(t) || /^0b[01]+$/i.test(t)) v = BigInt(t);
    else if (this.prefs.hex && /^[0-9a-f]+$/i.test(t)) v = BigInt('0x' + t);
    else if (/^\d+$/.test(t)) v = BigInt(t);
    else return undefined;
    if (neg) v = -v;
    const bits = BigInt(size * 8);
    if (v < -(1n << (bits - 1n)) || v >= (1n << bits)) return undefined;
    return fromBig(v, size);
  }

  /** "? ? ? ? ? ? ? 32" / "XXXXXXX 32" / "0 0 0 0 0 0 1 44" → 8 little-endian bytes, or null. */
  parseByteList(s) {
    const toks = s.trim().split(/\s+/);
    const msbFirst = [];
    for (const t of toks) {
      if (/^[?xX]+$/.test(t)) { for (let i = 0; i < t.length; i++) msbFirst.push(null); continue; }
      let v;
      if (/^0x[0-9a-f]{1,2}$/i.test(t)) v = parseInt(t, 16);
      else if (this.prefs.hex && /^[0-9a-f]{1,2}$/i.test(t)) v = parseInt(t, 16);
      else if (/^\d{1,3}$/.test(t)) v = parseInt(t, 10);
      else return null;
      if (v > 255) return null;
      msbFirst.push(v);
    }
    if (msbFirst.length !== 8) return null;
    return msbFirst.reverse();
  }

  /** Palette of values the player can drop: unknown + symbols currently in play. */
  palette() {
    const ids = new Set();
    const scan = (bytes) => bytes.forEach((b) => { if (b && typeof b === 'object') ids.add(b.s); });
    const m = this.step.before;
    for (const r of this.scenario.regs) scan(getReg(m, r));
    for (const v of m.mem.values()) if (v && typeof v === 'object') ids.add(v.s);
    for (const r of this.scenario.regs) scan(getReg(this.answer, r));
    for (const v of this.answer.mem.values()) if (v && typeof v === 'object') ids.add(v.s);
    if (this.step.meta.retSym) ids.add(this.step.meta.retSym);
    for (const o of this.step.ins.operands) if (o.t === 'imm' && o.sym && this.scenario.syms['&' + o.sym]) ids.add('&' + o.sym);
    const order = Object.keys(this.scenario.syms);
    return [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }

  applyValue(bytes) {
    const e = this.ui.edit || this.ui.sel;
    if (!e) { this.toast('Drag it onto a stack slot or register (or click a cell first)', 'info'); return; }
    this.ui.edit = null;
    if (e.kind === 'mem') this.setSlot(e.addr, bytes);
    else if (e.kind === 'byte') this.setByte(e.addr, bytes[0]);
    else if (e.kind === 'reg') this.setRegBytes(e.name, bytes);
    this.emit();
  }

  drop(payload, target) {
    if (!this.canEdit()) return;
    if (payload.kind === 'ptr') {
      if (target.kind === 'row') { this.movePtr(payload.name, target.addr); this.ui.sel = { kind: 'ptr', name: payload.name }; this.emit(); }
      return;
    }
    const bytes = payload.bytes;
    if (target.kind === 'mem') this.setSlot(target.addr, bytes);
    else if (target.kind === 'reg') this.setRegBytes(target.name, bytes);
    else if (target.kind === 'byte') this.setByte(target.addr, bytes[0]);
  }

  toast(msg, kind = 'info', ms = 2800) {
    const id = (this.ui.toast ? this.ui.toast.id : 0) + 1;
    this.ui.toast = { msg, kind, id };
    this.emit();
    setTimeout(() => { if (this.ui.toast && this.ui.toast.id === id) { this.ui.toast = null; this.emit(); } }, ms);
  }
}

function sameMachine(a, b, sc, lo) {
  for (const r of sc.regs) if (!bytesEq(getReg(a, r), getReg(b, r))) return false;
  for (let x = sc.hi; x >= lo; x -= 8) if (!bytesEq(readMem(a, x, 8), readMem(b, x, 8))) return false;
  return true;
}

export { PAPERS, TIERS, classify };
