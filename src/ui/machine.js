import { html, useRef, useLayoutEffect } from '../../vendor/preact-htm.js';
import { classify, readMem, getReg, bytesEq, valText, fmtNum, fmtByte, regNum, symBytes, unk } from '../sim.js';
import * as dnd from './dnd.js';

const SYM_ICON = { ret: '⮐', rbp: '⌂', label: '&' };

export function fmtAddr(a, hex) {
  return hex ? '0x' + a.toString(16) : String(a);
}

/** The value shown inside a cell/register. */
function ValueView({ game, bytes, big = false }) {
  const c = classify(bytes);
  const hex = game.prefs.hex;
  if (c.kind === 'num') {
    const s = fmtNum(c.v, hex);
    return html`<span class="v num ${s.length > 9 ? 'long' : ''} ${s.length > 14 ? 'xlong' : ''}">${s}</span>`;
  }
  if (c.kind === 'unk') return html`<span class="v unk">?</span>`;
  if (c.kind === 'sym') {
    const sy = game.scenario.syms[c.s] || { label: c.s, kind: 'ret' };
    return html`<span class="v sym k-${sy.kind}" title=${sy.desc || ''}><i>${SYM_ICON[sy.kind] || '•'}</i>${sy.label}</span>`;
  }
  return html`<span class="v mixed">${bytes.slice().reverse().map((b) => fmtByte(b, hex)).join(' ')}</span>`;
}

function dragLabel(game, bytes) {
  return valText(bytes, game.scenario.syms, game.prefs.hex);
}

function EditInput({ game, id, init, fallback, size }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.value = init !== null && init !== undefined ? init : fallback;
    el.focus();
    if (init !== null && init !== undefined) el.setSelectionRange(el.value.length, el.value.length);
    else el.select();
  }, [id]);
  const onKey = (e) => {
    e.stopPropagation();
    const el = e.currentTarget;
    if (e.key === 'Enter') {
      e.preventDefault();
      const closed = game.commitEdit(id, el.value);
      if (closed && (e.ctrlKey || e.metaKey || e.shiftKey)) game.check();
    }
    else if (e.key === 'Escape') { e.preventDefault(); game.cancelEdit(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Tab') {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1;
      if (game.commitEdit(id, el.value)) game.editNeighbor(dir);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && el.value === '') { e.preventDefault(); game.cancelEdit(); game.undo(); }
  };
  return html`<input ref=${ref} class="edit ${size === 1 ? 'edit-byte' : ''}" spellcheck="false" autocomplete="off"
    placeholder=${size === 1 ? '?' : game.prefs.hex ? 'hex / ? / sym' : 'number / ? / sym'}
    onKeyDown=${onKey} onBlur=${(e) => game.commitEdit(id, e.currentTarget.value, { fromBlur: true })}
    onPointerDown=${(e) => e.stopPropagation()} onClick=${(e) => e.stopPropagation()} />`;
}

function editText(game, bytes) {
  const c = classify(bytes);
  if (c.kind === 'num') return fmtNum(c.v, game.prefs.hex);
  if (c.kind === 'unk') return '?';
  if (c.kind === 'sym') return valText(bytes, game.scenario.syms);
  // mixed: exam-style byte list, most significant byte first
  return bytes.slice().reverse().map((b) => (typeof b === 'number' ? (game.prefs.hex ? '0x' + b.toString(16) : String(b)) : '?')).join(' ');
}

function ByteRow({ game, addr, bytes, editable, diffBytes }) {
  const e = game.ui.edit;
  const hex = game.prefs.hex;
  const boxes = [];
  for (let i = 7; i >= 0; i--) {
    const b = bytes[i];
    const editing = e && e.kind === 'byte' && e.addr === addr + i;
    const wrong = diffBytes && !bytesEq([diffBytes[i]], [b]);
    boxes.push(html`<div class="byte ${b === null ? 'unk' : typeof b === 'object' ? 'symb' : ''} ${wrong ? 'wrong' : ''}" key=${i}
      data-drop="byte" data-addr=${addr + i} title=${`M[${addr + i}] · offset +${i}`}
      onClick=${(ev) => { ev.stopPropagation(); if (!dnd.recentlyDragged() && editable) game.startEdit({ kind: 'byte', addr: addr + i }); }}>
      ${editing
        ? html`<${EditInput} game=${game} id=${e.id} init=${e.init} fallback=${b === null ? '?' : typeof b === 'object' ? '' : fmtByte(b, hex)} size=${1} />`
        : html`<span>${fmtByte(b, hex)}</span>`}
      <small>+${i}</small>
    </div>`);
  }
  return html`<div class="bytes">${boxes}</div>`;
}

function Cell({ game, addr, bytes, before, diff, editable, isSel }) {
  const e = game.ui.edit;
  const c = classify(bytes);
  const editing = e && e.kind === 'mem' && e.addr === addr;
  const byteEditing = e && e.kind === 'byte' && Math.floor(e.addr / 8) * 8 === addr;
  const expanded = game.ui.expanded.has(addr) || c.kind === 'mixed' || byteEditing || (diff && classify(diff.expected).kind === 'mixed' && game.ui.view === 'yours');
  const changed = !bytesEq(bytes, before);
  const onDown = (ev) => {
    if (!editable || editing) return;
    dnd.down(ev, { kind: 'value', bytes }, dragLabel(game, bytes), 'val', game);
  };
  const onClick = () => {
    if (dnd.recentlyDragged() || !editable) return;
    game.startEdit({ kind: 'mem', addr });
  };
  return html`<div class="cell k-${c.kind} ${changed ? 'changed' : ''} ${diff ? (game.ui.view === 'correct' ? 'fixed' : 'wrong') : ''} ${isSel ? 'sel' : ''} ${expanded ? 'expanded' : ''}"
      data-drop="mem" data-addr=${addr} onPointerDown=${onDown} onClick=${onClick}>
    ${editing
      ? html`<${EditInput} game=${game} id=${e.id} init=${e.init} fallback=${editText(game, bytes)} size=${8} />`
      : expanded
        ? html`<${ByteRow} game=${game} addr=${addr} bytes=${bytes} editable=${editable} diffBytes=${diff && game.ui.view === 'yours' ? diff.expected : null} />`
        : html`<${ValueView} game=${game} bytes=${bytes} />`}
    ${diff && game.ui.view === 'yours' && !expanded ? html`<span class="expect" title="correct value">✓ ${valText(diff.expected, game.scenario.syms, game.prefs.hex)}</span>` : null}
    ${editable && !editing ? html`<button class="bytes-toggle ${expanded ? 'on' : ''}" title="byte view (for movb / movw / movl)"
        onPointerDown=${(ev) => ev.stopPropagation()}
        onClick=${(ev) => { ev.stopPropagation(); game.toggleExpand(addr); }}>▦</button>` : null}
  </div>`;
}

function Pill({ game, name, ghost = false, preview = false, editable }) {
  const sel = game.ui.sel && game.ui.sel.kind === 'ptr' && game.ui.sel.name === name;
  const onDown = (ev) => {
    if (!editable || ghost) return;
    ev.stopPropagation();
    dnd.down(ev, { kind: 'ptr', name }, `%${name}`, 'ptr p-' + name, game);
  };
  return html`<div class="pill p-${name} ${sel ? 'sel' : ''} ${ghost ? 'ghost' : ''} ${preview ? 'preview' : ''}"
      title=${ghost ? `correct position of %${name}` : `drag, or select and use ↑/↓ (${name === 'rsp' ? 'W/S' : 'Shift+W/S'})`}
      onPointerDown=${onDown}
      onClick=${(ev) => { ev.stopPropagation(); if (!dnd.recentlyDragged() && !ghost && editable) game.selectPtr(name); }}>
    <span class="arr">◀</span>${ghost ? '✓ ' : ''}%${name}
    ${sel && editable ? html`<span class="nudge">
      <button onPointerDown=${(e) => e.stopPropagation()} onClick=${(e) => { e.stopPropagation(); game.nudgePtr(name, 8); game.ui.sel = { kind: 'ptr', name }; game.emit(); }} title="up (+8)">▲</button>
      <button onPointerDown=${(e) => e.stopPropagation()} onClick=${(e) => { e.stopPropagation(); game.nudgePtr(name, -8); game.ui.sel = { kind: 'ptr', name }; game.emit(); }} title="down (−8)">▼</button>
    </span>` : null}
  </div>`;
}

function RegTile({ game, name, bytes, before, diff, editable }) {
  const e = game.ui.edit;
  const editing = e && e.kind === 'reg' && e.name === name;
  const changed = !bytesEq(bytes, before);
  const isSel = game.ui.sel && game.ui.sel.kind === 'reg' && game.ui.sel.name === name;
  const c = classify(bytes);
  const onDown = (ev) => {
    if (!editable || editing) return;
    dnd.down(ev, { kind: 'value', bytes }, `%${name} = ${dragLabel(game, bytes)}`, 'val', game);
  };
  return html`<div class="reg r-${name} ${changed ? 'changed' : ''} ${diff ? (game.ui.view === 'correct' ? 'fixed' : 'wrong') : ''} ${isSel ? 'sel' : ''} k-${c.kind}"
      data-drop="reg" data-reg=${name} onPointerDown=${onDown}
      onClick=${() => { if (!dnd.recentlyDragged() && editable) game.startEdit({ kind: 'reg', name }); }}>
    <span class="rn">%${name}</span>
    <span class="rv">
      ${editing
        ? html`<${EditInput} game=${game} id=${e.id} init=${e.init} fallback=${editText(game, bytes)} size=${8} />`
        : html`<${ValueView} game=${game} bytes=${bytes} />`}
    </span>
    ${diff && game.ui.view === 'yours' ? html`<span class="expect">✓ ${valText(diff.expected, game.scenario.syms, game.prefs.hex)}</span>` : null}
  </div>`;
}

export function Machine({ game }) {
  const rowsRef = useRef(null);
  useLayoutEffect(() => {
    const el = rowsRef.current && rowsRef.current.querySelector('.row.is-top');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [game.scenario.id, game.stepIdx]);
  const sc = game.scenario;
  const st = game.step;
  const fbPhase = game.phase === 'wrong' || game.phase === 'dead';
  const showCorrect = fbPhase && game.ui.view === 'correct';
  const m = showCorrect ? st.after : game.answer;
  const before = st.before;
  const editable = game.canEdit();
  const diffs = fbPhase && game.feedback ? game.feedback.diffs : [];
  const dmem = new Map(), dreg = new Map();
  diffs.forEach((d) => (d.kind === 'mem' ? dmem.set(d.addr, d) : dreg.set(d.name, d)));
  const hex = game.prefs.hex;

  let rsp = regNum(m, 'rsp');
  let rbp = regNum(m, 'rbp');
  const pv = game.ui.ptrPreview;
  const truthRsp = regNum(st.after, 'rsp'), truthRbp = regNum(st.after, 'rbp');
  const ghostRsp = fbPhase && !showCorrect && dreg.has('rsp') ? truthRsp : null;
  const ghostRbp = fbPhase && !showCorrect && dreg.has('rbp') ? truthRbp : null;

  const rows = [];
  for (let a = sc.hi; a >= game.lo; a -= 8) rows.push(a);
  const inWin = (x) => x !== null && x <= sc.hi && x >= game.lo && x % 8 === 0;

  const parked = [];
  if (!inWin(rbp)) parked.push({ name: 'rbp', v: rbp === null ? valText(getReg(m, 'rbp'), sc.syms) : fmtAddr(rbp, hex) });
  if (!inWin(rsp)) parked.push({ name: 'rsp', v: rsp === null ? valText(getReg(m, 'rsp'), sc.syms) : fmtAddr(rsp, hex) });

  const sel = game.ui.sel;
  const topRow = sc.S;

  return html`<section class="machine ${game.phase} ${game.isBranch ? 'branching' : ''}">
    <div class="regs-col">
      <div class="panel-title">Registers <small>click · type · drag</small></div>
      <div class="regs">
        ${sc.regs.map((r) => html`<${RegTile} key=${r} game=${game} name=${r} bytes=${getReg(m, r)} before=${getReg(before, r)} diff=${dreg.get(r)} editable=${editable} />`)}
      </div>
      <div class="panel-title">Values <small>drag onto a slot</small></div>
      <div class="palette">
        <span class="chip k-unk" onPointerDown=${(e) => editable && dnd.down(e, { kind: 'value', bytes: unk() }, '?', 'val', game)}
          onMouseDown=${(e) => e.preventDefault()}
          onClick=${() => !dnd.recentlyDragged() && editable && game.applyValue(unk())} title="unknown / garbage">?</span>
        ${game.palette().map((id) => {
          const sy = sc.syms[id];
          return html`<span class="chip k-${sy.kind}" key=${id} title=${sy.desc}
            onPointerDown=${(e) => editable && dnd.down(e, { kind: 'value', bytes: symBytes(id) }, sy.label, 'val', game)}
            onMouseDown=${(e) => e.preventDefault()}
            onClick=${() => !dnd.recentlyDragged() && editable && game.applyValue(symBytes(id))}><i>${SYM_ICON[sy.kind]}</i>${sy.label}</span>`;
        })}
      </div>
      ${fbPhase ? html`<div class="viewtoggle">
        <button class=${game.ui.view === 'yours' ? 'on' : ''} onClick=${() => game.setView('yours')}>Your answer</button>
        <button class=${game.ui.view === 'correct' ? 'on' : ''} onClick=${() => game.setView('correct')}>Correct</button>
      </div>` : null}
    </div>

    <div class="stack-col">
      <div class="panel-title">Stack <small>↑ higher addresses</small></div>
      <div class="stack-head"><span>address</span><span>contents (8 bytes)</span><span>pointers</span></div>
      ${parked.length ? html`<div class="parked">${parked.map((p) => html`<div class="park" key=${p.name}>
          <${Pill} game=${game} name=${p.name} editable=${editable} /><span class="park-v">= ${p.v} <small>(not on screen)</small></span></div>`)}</div>` : null}
      <div class="rows" ref=${rowsRef}>
        ${rows.map((a) => {
          const bytes = readMem(m, a, 8);
          const isTop = inWin(rsp) && a === rsp;
          const free = rsp !== null && a < rsp;
          const inFrame = rbp !== null && rsp !== null && a >= rsp && a <= rbp;
          const pills = [];
          if (pv && pv.addr === a) pills.push(html`<${Pill} key="pv" game=${game} name=${pv.name} preview editable=${editable} />`);
          if (rsp === a && !(pv && pv.name === 'rsp')) pills.push(html`<${Pill} key="rsp" game=${game} name="rsp" editable=${editable} />`);
          if (rbp === a && !(pv && pv.name === 'rbp')) pills.push(html`<${Pill} key="rbp" game=${game} name="rbp" editable=${editable} />`);
          if (ghostRsp === a) pills.push(html`<${Pill} key="grsp" game=${game} name="rsp" ghost />`);
          if (ghostRbp === a) pills.push(html`<${Pill} key="grbp" game=${game} name="rbp" ghost />`);
          return html`<div key=${a} data-row=${a} class="row ${free ? 'free' : 'live'} ${isTop ? 'is-top' : ''} ${a > topRow ? 'caller' : ''} ${inFrame ? 'frame' : ''}">
            <div class="addr">${fmtAddr(a, hex)}</div>
            <${Cell} game=${game} addr=${a} bytes=${bytes} before=${readMem(before, a, 8)} diff=${dmem.get(a)} editable=${editable}
              isSel=${sel && sel.kind === 'mem' && sel.addr === a} />
            <div class="ptrs">${pills}</div>
          </div>`;
        })}
      </div>
      <div class="stack-foot">↓ lower addresses · the stack grows this way</div>
      ${game.isBranch && game.phase === 'play' ? html`<div class="branch-veil"><div>A jump never touches the stack.<br/><b>Where does execution go next?</b></div></div>` : null}
    </div>
  </section>`;
}
