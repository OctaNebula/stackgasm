import { html, useRef, useLayoutEffect } from '../../vendor/preact-htm.js';
import { Asm, Rich } from './markup.js';
import { Machine } from './machine.js';
import { Reference } from './reference.js';
import { TIERS, PAPERS } from '../game.js';
import { valText } from '../sim.js';

function Header({ game }) {
  const modes = [['endless', 'Endless'], ['practice', 'Practice'], ['papers', 'Past papers']];
  const tier = game.mode === 'papers' ? null : game.scenario.tier;
  return html`<header class="top">
    <div class="top-left">
      <nav class="modes">
        ${modes.map(([id, label]) => html`<button key=${id} class=${game.mode === id ? 'on' : ''}
          title=${game.mode === id ? 'current mode' : ''}
          onClick=${() => { if (game.mode !== id || game.phase === 'dead') game.start(id); }}>${label}</button>`)}
      </nav>
      ${game.mode === 'practice' ? html`<label class="subsel">difficulty
        <select value=${game.prefs.difficulty} onChange=${(e) => game.setDifficulty(e.currentTarget.value)}>
          <option value="auto">auto-ramp</option>
          ${TIERS.map((t, i) => html`<option value=${String(i)}>${i + 1} · ${t.name}</option>`)}
        </select></label>` : null}
      ${game.mode === 'papers' ? html`<label class="subsel">paper
        <select value=${game.prefs.paper} onChange=${(e) => game.setPaper(e.currentTarget.value)}>
          ${PAPERS.map((p) => html`<option value=${p.id}>${p.short}</option>`)}
        </select></label>` : null}
    </div>
    <div class="brand" title="stack + gASM (GNU as)">stack<span class="g">g</span><span class="asm">ASM</span><span class="cursor"></span></div>
    <div class="top-right">
      <div class="stats">
        ${tier !== null ? html`<div class="stat tier" title=${TIERS[tier].desc}><small>tier</small><b>${tier + 1}</b><span>${TIERS[tier].name}</span></div>` : null}
        <div class="stat"><small>${game.mode === 'endless' ? 'score' : 'solved'}</small><b class="score ${game.phase === 'ok' ? 'bump' : ''}" key=${game.score}>${game.score}</b></div>
        ${game.mode === 'endless'
          ? html`<div class="stat"><small>best</small><b class=${game.newBest ? 'gold' : ''}>${game.best}</b></div>`
          : html`<div class="stat"><small>misses</small><b>${game.mistakes}</b></div>`}
        ${game.mode !== 'endless' && game.streak >= 3 ? html`<div class="stat streak"><small>streak</small><b>${game.streak}</b></div>` : null}
      </div>
      <div class="tools">
        <button class=${game.prefs.hex ? 'on' : ''} onClick=${() => game.toggleHex()} title="show numbers in hex">${game.prefs.hex ? 'HEX' : 'DEC'}</button>
        <button onClick=${() => game.toggleSound()} title="sound">${game.prefs.sound ? '♪' : '♪̸'}</button>
        <button class="refbtn" onClick=${() => game.toggleRef(true)} title="cheat sheet (F1)">?<span class="reftxt"> Cheat sheet</span></button>
      </div>
    </div>
  </header>`;
}

function History({ game }) {
  const sc = game.scenario;
  const compact = game.phase === 'wrong' || game.phase === 'dead';
  const done = game.phase === 'routineDone' || game.phase === 'paperDone';
  const end = done ? game.stepIdx + 1 : game.stepIdx;
  const from = Math.max(0, end - (compact ? 2 : 6));
  const hist = sc.steps.slice(from, end);
  return html`<div class="history">
    ${hist.map((h, i) => {
      const age = hist.length - i;
      return html`<div class="hist" key=${from + i} style=${`--age:${age}`}>
        ${h.label ? html`<div class="hlabel">${h.label}:</div>` : null}
        <div class="hline"><span class="lineno">${h.lineNo}</span><span class="ok">✓</span><${Asm} text=${h.text} />
          ${h.info.branch ? html`<span class="tag">${h.info.branch.taken ? 'taken' : 'not taken'}</span>` : null}</div>
        ${h.skipped && h.skipped.length ? html`<div class="skipped">${h.skipped.map((s) => html`<div><span class="skip-tag">skipped</span><span class="skip-code"><${Asm} text=${s} /></span></div>`)}</div>` : null}
      </div>`;
    })}
  </div>`;
}

function Current({ game }) {
  const sc = game.scenario, st = game.step;
  const nested = st.fn && st.fn !== sc.fn;
  return html`<div class="current ${game.phase}" key=${sc.id + ':' + game.stepIdx}>
    ${nested ? html`<div class="crumb">inside <code>${st.fn}</code> <span>← called from <code>${sc.fn}</code></span></div>` : null}
    ${st.label ? html`<div class="clabel">${st.label}:</div>` : null}
    <div class="cline">
      <span class="lineno">${st.lineNo}</span>
      <span class="caret">▶</span>
      <span class="bigwrap" style=${`--len:${Math.max(st.text.length, 8)}`}><${Asm} text=${st.text} cls="big" /></span>
      ${game.isNew ? html`<span class="new">new</span>` : null}
    </div>
    ${st.note ? html`<div class="io">⌨ ${st.note}</div>` : null}
  </div>`;
}

function Actions({ game }) {
  const p = game.phase;
  if (p === 'play' && game.isBranch) {
    return html`<div class="actions branch">
      <button class="big-btn taken" onClick=${() => game.choose(true)}>Jump taken <kbd>T</kbd></button>
      <button class="big-btn nottaken" onClick=${() => game.choose(false)}>Not taken <kbd>N</kbd></button>
    </div>`;
  }
  if (p === 'play' || p === 'ok') {
    return html`<div class="actions">
      <button class="big-btn check ${p === 'ok' ? 'ok' : ''}" onClick=${() => game.check()}>${p === 'ok' ? '✓ correct' : html`Check <kbd>⏎</kbd>`}</button>
      <div class="minor">
        <button onClick=${() => game.undo()} disabled=${!game.undoStack.length || p !== 'play'} title="Ctrl+Z">↶ undo</button>
        <button onClick=${() => game.reset()} disabled=${p !== 'play'} title="back to the state before this instruction">⟲ reset</button>
      </div>
    </div>`;
  }
  return null;
}

function Feedback({ game }) {
  const p = game.phase;
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [p, game.stepIdx]);
  if (p !== 'wrong' && p !== 'dead') return null;
  const st = game.step;
  const fb = game.feedback || { diffs: [], mistakes: [] };
  const dead = p === 'dead';
  const V = (b) => valText(b, game.scenario.syms, game.prefs.hex);
  return html`<div class="feedback ${dead ? 'dead' : ''}" ref=${ref}>
    <div class="fb-head">
      <div class="fb-title">${dead ? html`<span class="sig">SIGSEGV</span> game over` : 'Not quite.'}</div>
      ${dead ? html`<div class="fb-score">score <b>${game.score}</b>${game.newBest ? html` · <span class="gold">new best!</span>` : html` · best ${game.best}`}</div>` : null}
    </div>
    ${fb.mistakes.length ? html`<div class="fb-sec why">
      <h4>Why</h4>
      ${fb.mistakes.map((m) => html`<p><${Rich} text=${m} /></p>`)}
    </div>` : null}
    <div class="fb-sec">
      <h4>What <${Asm} text=${st.text} /> really does</h4>
      <ol class="steps">${st.explain.map((e) => html`<li><${Rich} text=${e} /></li>`)}</ol>
    </div>
    ${fb.diffs.length ? html`<div class="fb-sec">
      <h4>Differences</h4>
      <table class="diffs">
        <thead><tr><th></th><th>yours</th><th>correct</th><th></th></tr></thead>
        <tbody>${fb.diffs.map((d) => html`<tr>
          <td class="loc">${d.kind === 'reg' ? html`<code class="t-reg">%${d.name}</code>` : html`<code>M[${d.addr}]</code>`}</td>
          <td class="bad">${V(d.yours)}</td><td class="good">${V(d.expected)}</td>
          <td class="note">${d.note}</td></tr>`)}</tbody>
      </table>
    </div>` : null}
    <div class="fb-actions">
      <button class="big-btn primary" onClick=${() => game.primary()}>${dead ? 'Play again' : 'Continue'} <kbd>⏎</kbd></button>
      ${dead ? html`<button class="big-btn ghost" onClick=${() => game.start('practice')}>Practice mode</button>` : null}
    </div>
  </div>`;
}

function Done({ game }) {
  if (game.phase === 'routineDone') {
    return html`<div class="done">
      <div class="done-title">✓ <code>${game.scenario.fn}</code> returned</div>
      <div class="done-sub">routine cleared · next one incoming</div>
      <div class="bar"><i></i></div>
      <button class="big-btn primary" onClick=${() => game.primary()}>Next routine <kbd>⏎</kbd></button>
    </div>`;
  }
  if (game.phase === 'paperDone') {
    const other = PAPERS.find((x) => x.id !== game.prefs.paper);
    return html`<div class="done paper">
      <div class="done-title">✓ ${game.scenario.title} complete</div>
      <p class="outro"><${Rich} text=${game.scenario.outro} /></p>
      <div class="fb-actions">
        <button class="big-btn primary" onClick=${() => game.primary()}>Replay <kbd>⏎</kbd></button>
        ${other ? html`<button class="big-btn ghost" onClick=${() => game.setPaper(other.id)}>${other.short}</button>` : null}
        <button class="big-btn ghost" onClick=${() => game.start('endless')}>Endless mode</button>
      </div>
    </div>`;
  }
  return null;
}

function Stage({ game }) {
  const sc = game.scenario, st = game.step;
  return html`<section class="stage">
    <div class="routine">
      <div class="kicker">${sc.kind === 'paper' ? sc.title : sc.endless ? html`endless <span class="dot">·</span> main never returns` : html`routine <span class="dot">·</span> #${game.routines + 1}`}</div>
      <div class="sig"><span class="fn">${sc.fn}</span><span class="args">(${sc.argsText})</span></div>
      ${sc.question ? html`<div class="question">${sc.question}</div>` : null}
      ${sc.notes && sc.notes.length ? html`<div class="notes">${sc.notes.map((n) => html`<span>${n}</span>`)}</div>` : null}
    </div>
    <div class="tape">
      <${History} game=${game} />
      ${game.phase === 'routineDone' || game.phase === 'paperDone' ? null : html`<${Current} game=${game} />`}
    </div>
    ${st.checkpoint && game.phase === 'play' ? html`<div class="checkpoint"><${Rich} text=${st.checkpoint} /></div>` : null}
    <${Actions} game=${game} />
    <${Feedback} game=${game} />
    <${Done} game=${game} />
    ${game.phase === 'play' ? html`<div class="legend">
      <span><kbd>click</kbd> a slot/register, type a value, <kbd>⏎</kbd></span>
      <span><kbd>drag</kbd> values & the <b class="c-rsp">%rsp</b>/<b class="c-rbp">%rbp</b> arrows</span>
      <span><kbd>W</kbd>/<kbd>S</kbd> move %rsp · <kbd>⇧W</kbd>/<kbd>⇧S</kbd> move %rbp</span>
      <span><kbd>?</kbd> unknown · <kbd>▦</kbd> byte view · <kbd>Ctrl Z</kbd> undo</span>
    </div>` : null}
  </section>`;
}

function Toast({ game }) {
  const t = game.ui.toast;
  if (!t) return null;
  return html`<div class="toast ${t.kind}" key=${t.id}>${t.msg}</div>`;
}

export function App({ game }) {
  return html`<div class="app phase-${game.phase} mode-${game.mode}">
    <${Header} game=${game} />
    <main class="main">
      <${Stage} game=${game} />
      <${Machine} game=${game} />
    </main>
    ${game.ui.ref ? html`<${Reference} game=${game} />` : null}
    <${Toast} game=${game} />
  </div>`;
}
