import { html, render } from '../vendor/preact-htm.js';
import { Game } from './game.js';
import { App } from './ui/app.js';
import { regNum } from './sim.js';

const root = document.getElementById('app');
let queued = false;
const game = new Game(() => {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; draw(); });
});
function draw() { render(html`<${App} game=${game} />`, root); }
window.__game = game; // handy for poking around in devtools
draw();

window.addEventListener('keydown', (e) => {
  const ae = document.activeElement;
  const k = e.key;
  if (k === 'F1') { e.preventDefault(); game.toggleRef(); return; }
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA')) return;
  if (game.ui.ref) { if (k === 'Escape') game.toggleRef(false); return; }
  if (e.ctrlKey || e.metaKey) {
    if (k.toLowerCase() === 'z') { e.preventDefault(); game.undo(); }
    return;
  }
  if (e.altKey) return;
  if (k === 'Enter') {
    e.preventDefault();
    if (ae && ae.tagName === 'BUTTON') ae.blur();
    game.primary();
    return;
  }
  if (game.phase === 'play' && game.isBranch) {
    if (k === 't' || k === 'T' || k === 'y' || k === 'Y') game.choose(true);
    else if (k === 'n' || k === 'N') game.choose(false);
    return;
  }
  if (!game.canEdit()) return;
  const sel = game.ui.sel;
  if (k === 'w' || k === 'W') { e.preventDefault(); game.nudgePtr(e.shiftKey ? 'rbp' : 'rsp', 8); return; }
  if (k === 's' || k === 'S') { e.preventDefault(); game.nudgePtr(e.shiftKey ? 'rbp' : 'rsp', -8); return; }
  if (k === 'ArrowUp' || k === 'ArrowDown') {
    e.preventDefault();
    if (sel) game.moveSel(k === 'ArrowUp' ? -1 : 1);
    else game.select({ kind: 'mem', addr: regNum(game.answer, 'rsp') ?? game.scenario.S });
    return;
  }
  if (k === 'Escape') { game.select(null); return; }
  if (k === 'Delete' || k === 'Backspace') { if (sel) { e.preventDefault(); game.clearSel(); } return; }
  if ((k === 'F2' || k === ' ') && sel && sel.kind !== 'ptr') { e.preventDefault(); game.startEdit(sel); return; }
  const isDigitish = /^[0-9\-?xX&]$/.test(k) || /^[a-zA-Z]$/.test(k);
  if (isDigitish && sel && (sel.kind === 'mem' || sel.kind === 'reg')) { e.preventDefault(); game.startEdit(sel, k); }
});

// Clicking empty space clears the selection.
window.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.cell, .reg, .pill, .chip, .byte, button, input, select, .ref')) {
    if (game.ui.sel && game.ui.sel.kind !== 'ptr') game.select(null);
    else if (game.ui.sel && !e.target.closest('.row')) game.select(null);
  }
});
