import { html } from '../../vendor/preact-htm.js';

const TOK = /(%[a-z0-9]+)|(\$-?[\w.]+)|(-?0x[0-9a-f]+|-?\d+)|([(),])|(\s+)|([A-Za-z_.][\w.]*)|(.)/gi;

/** Syntax-highlighted AT&T instruction. */
export function Asm({ text, cls = '' }) {
  const m = text.match(/^(\S+)(\s*)(.*)$/);
  if (!m) return html`<span class="asm ${cls}">${text}</span>`;
  const [, mnem, sp, rest] = m;
  const parts = [];
  let t;
  TOK.lastIndex = 0;
  let i = 0;
  while ((t = TOK.exec(rest))) {
    const [s, reg, imm, num, punct, ws, word] = t;
    const k = reg ? 't-reg' : imm ? 't-imm' : num ? 't-num' : punct ? 't-punct' : ws ? '' : word ? 't-label' : '';
    parts.push(k ? html`<span class=${k} key=${i++}>${s}</span>` : s);
  }
  return html`<span class="asm ${cls}"><span class="t-op">${mnem}</span>${sp ? ' ' : ''}${parts}</span>`;
}

const RICH = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\{\{[^}]+\}\})/g;

/** Render the tiny explanation markup: `code`, **bold**, {{dim}}. Nested markup inside {{…}} is supported one level. */
export function Rich({ text }) {
  return html`<span class="rich">${renderRich(text)}</span>`;
}
function renderRich(text, depth = 0) {
  const out = [];
  let last = 0, m, k = 0;
  RICH.lastIndex = 0;
  const re = new RegExp(RICH.source, 'g');
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    if (m[1]) out.push(html`<code key=${k++}>${codeInner(s.slice(1, -1))}</code>`);
    else if (m[2]) out.push(html`<b key=${k++}>${s.slice(2, -2)}</b>`);
    else if (m[3]) out.push(html`<span class="dim" key=${k++}>${depth < 1 ? renderRich(s.slice(2, -2), depth + 1) : s.slice(2, -2)}</span>`);
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function codeInner(s) {
  if (/^[a-z]{2,6}[bwlq]?\s/.test(s)) return html`<${Asm} text=${s} />`;
  if (/^%[a-z0-9]+$/.test(s)) return html`<span class="t-reg">${s}</span>`;
  if (/^\$/.test(s)) return html`<span class="t-imm">${s}</span>`;
  return s;
}
