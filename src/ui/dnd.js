// Minimal pointer-based drag & drop: values between cells/registers, and the %rsp/%rbp arrows between rows.

let st = null;
let lastDragEnd = 0;

export const recentlyDragged = () => performance.now() - lastDragEnd < 250;

/**
 * Start a potential drag. payload: { kind: 'value', bytes } | { kind: 'ptr', name }
 * game.drop(payload, target) and game.previewPtr(name, addr|null) are called.
 */
export function down(e, payload, label, cls, game) {
  if (e.button !== 0) return;
  st = { payload, x0: e.clientX, y0: e.clientY, started: false, label, cls, game, ghost: null, hover: null };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

function targetAt(x, y) {
  if (!st) return null;
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  if (st.payload.kind === 'ptr') {
    const row = el.closest('[data-row]');
    return row ? { kind: 'row', addr: Number(row.dataset.row), el: row } : null;
  }
  const d = el.closest('[data-drop]');
  if (!d) return null;
  const kind = d.dataset.drop;
  if (kind === 'mem') return { kind, addr: Number(d.dataset.addr), el: d };
  if (kind === 'byte') return { kind, addr: Number(d.dataset.addr), el: d };
  if (kind === 'reg') return { kind, name: d.dataset.reg, el: d };
  return null;
}

function move(e) {
  if (!st) return;
  if (!st.started) {
    if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < 6) return;
    st.started = true;
    const g = document.createElement('div');
    g.className = `drag-ghost ${st.cls || ''}`;
    g.textContent = st.label;
    document.body.appendChild(g);
    st.ghost = g;
    document.body.classList.add('dragging');
  }
  st.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY - 14}px)`;
  const t = targetAt(e.clientX, e.clientY);
  if (st.hover && (!t || t.el !== st.hover)) st.hover.classList.remove('drop-hover');
  if (t && t.el !== st.hover) t.el.classList.add('drop-hover');
  st.hover = t ? t.el : null;
  if (st.payload.kind === 'ptr') st.game.previewPtr(st.payload.name, t ? t.addr : null);
}

function cleanup() {
  window.removeEventListener('pointermove', move);
  window.removeEventListener('pointerup', up);
  window.removeEventListener('pointercancel', cancel);
  if (st && st.ghost) st.ghost.remove();
  if (st && st.hover) st.hover.classList.remove('drop-hover');
  document.body.classList.remove('dragging');
}

function up(e) {
  const s = st;
  cleanup();
  st = null;
  if (!s || !s.started) return;
  lastDragEnd = performance.now();
  st = s; // targetAt reads st
  const t = targetAt(e.clientX, e.clientY);
  st = null;
  if (s.payload.kind === 'ptr') s.game.previewPtr(s.payload.name, null);
  if (t) s.game.drop(s.payload, t);
}

function cancel() {
  const s = st;
  cleanup();
  st = null;
  if (s && s.payload.kind === 'ptr') s.game.previewPtr(s.payload.name, null);
}
