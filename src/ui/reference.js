import { html } from '../../vendor/preact-htm.js';
import { Asm } from './markup.js';

const ROWS = [
  ['pushq src', '%rsp ← %rsp − 8, then M[%rsp] ← src', 'decrement FIRST, then store'],
  ['popq dst', 'dst ← M[%rsp], then %rsp ← %rsp + 8', 'memory is NOT erased'],
  ['movq src, dst', 'dst ← src', 'AT&T: source first, destination last'],
  ['movb/movw/movl', 'write 1 / 2 / 4 bytes', 'other bytes of the slot stay'],
  ['leaq mem, reg', 'reg ← address of mem', 'never reads memory'],
  ['movzbq / movsbq', 'load 1 byte, zero/sign-extend to 8', 'ignores the other 7 bytes'],
  ['addq src, dst', 'dst ← dst + src', ''],
  ['subq src, dst', 'dst ← dst − src', 'right minus left'],
  ['subq $16, %rsp', 'allocate 16 bytes (2 slots)', 'contents = garbage'],
  ['addq $16, %rsp', 'free 16 bytes', 'nothing erased'],
  ['incq / decq / negq', 'dst ± 1 / dst ← −dst', ''],
  ['shlq $k, dst', 'dst ← dst × 2^k', 'shrq ÷ (logical), sarq ÷ (keeps sign, rounds down)'],
  ['imulq src, dst', 'dst ← dst × src', ''],
  ['mulq src', '%rdx:%rax ← %rax × src', 'writes BOTH %rax and %rdx'],
  ['cmpq src, dst', 'flags from dst − src', 'changes nothing else'],
  ['jl / jg / je …', 'jump if dst < / > / = src', 'from the last cmp'],
  ['call f', 'push return address, jump to f', '%rsp − 8'],
  ['ret', 'pop return address into %rip', '%rsp + 8'],
  ['leave', 'movq %rbp, %rsp + popq %rbp', ''],
];

export function Reference({ game }) {
  return html`<div class="ref-overlay" onClick=${(e) => { if (e.target === e.currentTarget) game.toggleRef(false); }}>
    <div class="ref">
      <button class="ref-close" onClick=${() => game.toggleRef(false)}>✕</button>
      <h2>Cheat sheet <small>x86-64 · AT&T syntax · CSE1400</small></h2>

      <div class="ref-grid">
        <section>
          <h3>The stack in one picture</h3>
          <div class="mini-stack">
            <div class="ms-row"><span>408</span><div>caller stuff</div><em></em></div>
            <div class="ms-row"><span>400</span><div class="sym">⮐ ret</div><em></em></div>
            <div class="ms-row"><span>392</span><div class="sym b">old rbp</div><em class="c-rbp">◀ %rbp</em></div>
            <div class="ms-row"><span>384</span><div>local / pushed</div><em></em></div>
            <div class="ms-row"><span>376</span><div>local / pushed</div><em class="c-rsp">◀ %rsp</em></div>
            <div class="ms-row free"><span>368</span><div>old junk (still there!)</div><em></em></div>
          </div>
          <ul>
            <li>Higher addresses on top. The stack <b>grows down</b>: push = lower address.</li>
            <li><code>%rsp</code> points AT the top value (the last pushed 8 bytes).</li>
            <li>Everything below <code>%rsp</code> is free — but it is <b>not erased</b>. Old values stay until overwritten.</li>
            <li>Each row is 8 bytes: the slot at 384 covers 384 … 391.</li>
          </ul>
        </section>

        <section>
          <h3>Operands</h3>
          <table class="ops">
            <tr><td><code class="t-imm">$5</code></td><td>the number 5 (immediate)</td></tr>
            <tr><td><code class="t-reg">%rax</code></td><td>a register</td></tr>
            <tr><td><code>8(%rsp)</code></td><td>memory at %rsp + 8</td></tr>
            <tr><td><code>-16(%rbp)</code></td><td>memory at %rbp − 16</td></tr>
            <tr><td><code>(%rbp,%r12,1)</code></td><td>memory at %rbp + %r12×1</td></tr>
            <tr><td><code>$format</code></td><td>the ADDRESS of a label</td></tr>
          </table>
          <p class="ref-note">Suffix = size: <b>b</b>=1, <b>w</b>=2, <b>l</b>=4, <b>q</b>=8 bytes. <code>%eax</code> = low 4 bytes of %rax (writing it zeroes the upper 4), <code>%ax</code> = low 2, <code>%al</code> = low 1.</p>
        </section>

        <section class="wide">
          <h3>Instructions</h3>
          <table class="instr">
            ${ROWS.map(([a, b, c]) => html`<tr><td><${Asm} text=${a} /></td><td>${b}</td><td class="dim">${c}</td></tr>`)}
          </table>
        </section>

        <section>
          <h3>Little-endian (for movb / movw / movl)</h3>
          <p>The byte at the <b>lowest</b> address is the <b>least significant</b>. In the byte view the rightmost box is offset +0.</p>
          <div class="endian">
            <div class="eb">?</div><div class="eb">?</div><div class="eb">?</div><div class="eb">?</div><div class="eb">?</div><div class="eb">?</div><div class="eb">?</div><div class="eb hot">32</div>
            <div class="el">+7</div><div class="el">+6</div><div class="el">+5</div><div class="el">+4</div><div class="el">+3</div><div class="el">+2</div><div class="el">+1</div><div class="el">+0</div>
          </div>
          <p class="ref-note">After <code>subq $8, %rsp</code> + <code>movb $32, (%rsp)</code> the slot is <b>? ? ? ? ? ? ? 32</b> — not 32! (2024 midterm)<br/>
          <code>movb $2</code> onto a slot holding 255 (0x00…00FF) gives 0x00…0002 = <b>2</b>.</p>
        </section>

        <section>
          <h3>Frames</h3>
          <div class="code-block">
            <div><${Asm} text="pushq %rbp" /> <span class="dim"># save caller's rbp</span></div>
            <div><${Asm} text="movq %rsp, %rbp" /> <span class="dim"># new frame base</span></div>
            <div><${Asm} text="subq $16, %rsp" /> <span class="dim"># locals: -8(%rbp), -16(%rbp)</span></div>
            <div class="dim">…</div>
            <div><${Asm} text="movq %rbp, %rsp" /> <span class="dim"># or: leave</span></div>
            <div><${Asm} text="popq %rbp" /></div>
            <div><${Asm} text="ret" /></div>
          </div>
          <p class="ref-note">Stack arguments: after the prologue the argument pushed <b>last</b> (right before <code>call</code>) is at <code>16(%rbp)</code>, the one pushed before it at <code>24(%rbp)</code> — because <code>8(%rbp)</code> = return address and <code>0(%rbp)</code> = old rbp.</p>
        </section>

        <section>
          <h3>Calls to scanf / printf</h3>
          <ul>
            <li><code>call</code> pushes the return address at %rsp − 8; the function's <code>ret</code> pops it again.</li>
            <li>So after the call %rsp is back — but <b>M[%rsp − 8] now holds that return address</b>. (2025 midterm: this overwrote the 21 at 368.)</li>
            <li><code>scanf("%ld", %rsi)</code> writes 8 bytes at the address in %rsi.</li>
            <li>Args: %rdi, %rsi, %rdx, %rcx, %r8, %r9 · return value in %rax.</li>
            <li>Caller-saved (%rax, %rdi, %rsi, %rdx, %rcx, %r8–%r11) may be garbage after any call. Callee-saved (%rbx, %rbp, %r12–%r15) must be restored before <code>ret</code>.</li>
          </ul>
        </section>

        <section>
          <h3>cmp + jump</h3>
          <p><${Asm} text="cmpq $100, %rsi" /> then <${Asm} text="jl calculation" /> reads as <b>“if %rsi &lt; 100 goto calculation”</b> — destination compared to source.</p>
          <table class="ops">
            <tr><td>je / jne</td><td>= / ≠</td></tr>
            <tr><td>jl / jle</td><td>&lt; / ≤ (signed)</td></tr>
            <tr><td>jg / jge</td><td>&gt; / ≥ (signed)</td></tr>
            <tr><td>jb / ja</td><td>&lt; / &gt; (unsigned)</td></tr>
          </table>
        </section>

        <section>
          <h3>Exam traps checklist</h3>
          <ul class="traps">
            <li>Operand order: the destination is on the <b>right</b>.</li>
            <li><code>pop</code>/<code>ret</code>/<code>addq $n,%rsp</code> never erase memory.</li>
            <li><code>subq $n,%rsp</code> creates <b>garbage</b> slots, not zeros.</li>
            <li><code>movb</code> changes 1 byte; the rest of the slot may still be garbage.</li>
            <li><code>lea</code> = address arithmetic, no memory read.</li>
            <li>Offsets like <code>8(%rsp)</code> use the <b>current</b> %rsp.</li>
            <li>Library calls leave their return address below %rsp.</li>
            <li>Reading garbage gives garbage: results become unknown.</li>
          </ul>
        </section>

        <section>
          <h3>How to play</h3>
          <ul>
            <li>Make the right panel look like the machine <b>after</b> the instruction, then <kbd>⏎</kbd>.</li>
            <li>Click a slot or register and type: <code>42</code>, <code>-8</code>, <code>0x1f</code>, <code>?</code> (unknown), or a symbol like <code>old rbp</code>.</li>
            <li>Drag values between slots/registers. Drag the <b class="c-rsp">%rsp</b>/<b class="c-rbp">%rbp</b> arrows, or use <kbd>W</kbd>/<kbd>S</kbd> (+<kbd>⇧</kbd> for rbp).</li>
            <li>After <kbd>S</kbd> the new top slot is selected: just type the pushed value and press <kbd>⏎</kbd> twice.</li>
            <li>▦ opens the byte view (offset +7 … +0) for partial writes — or just type the 8 bytes exam-style into the slot: <code>XXXXXXX 32</code> or <code>? ? ? ? ? ? ? 32</code>.</li>
            <li><kbd>Ctrl</kbd>+<kbd>⏎</kbd> inside an input = commit and check in one go.</li>
            <li>Arrow keys move the selection; inside an input they commit and move.</li>
          </ul>
        </section>
      </div>
      <p class="ref-foot">Press <kbd>F1</kbd> or <kbd>Esc</kbd> to close.</p>
    </div>
  </div>`;
}
