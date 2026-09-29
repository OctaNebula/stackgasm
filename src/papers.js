// The two stack questions from the past CSE1400 midterms, replayable step by step.

import { runListing, baseSyms, entryMachine } from './trace.js';
import { writeMem, fromBig } from './sim.js';

const BLINDS = `blinds:
    pushq   %rbp
    movq    %rsp, %rbp

    pushq   $5
    pushq   %rdi
    subq    $8, %rsp
    pushq   %rsi

    movb    $32, 8(%rsp)
    movb    $2, 16(%rsp)

    cmpq    $100, %rsi
    jl      calculation

    pushq   $2

calculation:
    popq    %rax
    popq    %rsi
    mulq    %rsi

    subq    (%rsp), %rax
    addq    8(%rsp), %rax

    movq    %rbp, %rsp
    popq    %rbp
    ret`;

const SCANF = `main:
    push    %rbp
    mov     %rsp, %rbp

    subq    $16, %rsp
    leaq    -16(%rbp), %rsi
    movq    $format, %rdi
    movq    $0, %rax

    call    scanf

    popq    %r12

    leaq    (%rbp, %r12, 1), %rsi
    movq    $format, %rdi
    movq    $0, %rax

    call    scanf

    subq    (%rsp), %rsp
    movq    (%rsp), %rax
    addq    %rax, (%rsp)`;

export const PAPERS = [
  {
    id: '2024',
    short: '2024 · blinds',
    title: 'Midterm 2024-10-04 · Q11',
    fn: 'blinds',
    argsText: 'rdi = 255, rsi = 512',
    question: 'The values passed to “blinds” are 255 in RDI and 512 in RSI. (a) What is the state of the stack just before executing line 19? (b) Why is the output inconsistent for the same input?',
    notes: ['%rsp = 400 on entry (the exam leaves addresses to you)'],
    build() {
      const syms = baseSyms('blinds');
      const init = entryMachine(400, { regs: { rax: null, rdx: null, rsi: 512n, rdi: 255n } });
      const steps = runListing(BLINDS, {
        init, syms, fn: 'blinds',
        lineMeta: {
          19: { checkpoint: 'Exam checkpoint — Q11(a) asks for the stack right now (before line 19). Answer key, top to bottom: RBP · 5 · 2 · X X X X X X X 32 · 512 · 2 (X = unknown byte).' },
          23: { checkpoint: 'Q11(b): the slot at (%rsp) still has 7 unknown garbage bytes (only 1 byte was written by movb) — that garbage feeds into this subtraction, so the result changes from run to run.' },
        },
      });
      return { regs: ['rax', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp'], syms, S: 400, steps, init };
    },
    outro: 'Q11(b): the 7 unknown bytes left by `subq $8, %rsp` + `movb $32` are read on line 23, so the output depends on whatever garbage happened to be there.',
  },
  {
    id: '2025',
    short: '2025 · scanf',
    title: 'Midterm 2025-10-03 · Q10',
    fn: 'main',
    argsText: 'first input −8, second input 16',
    question: 'The first input is −8 and the second is 16. The stack pointer starts at 400 and address 368 holds 21. Show the stack after the code finishes, with the final RSP and RBP.',
    notes: ['M[368] holds 21 before main runs', 'M[400] is unknown (the exam says so)'],
    build() {
      const syms = baseSyms('main');
      const init = entryMachine(400, { ret0: false, regs: { rax: null, rsi: null, rdi: null, r12: null } });
      writeMem(init, 368, fromBig(21n));
      const steps = runListing(SCANF, {
        init, syms, fn: 'main',
        lineMeta: {
          10: { meta: { lib: { name: 'scanf', input: -8n, ret: 1n } }, note: 'stdin: you type −8 ⏎  ·  scanf returns 1 in %rax' },
          18: { meta: { lib: { name: 'scanf', input: 16n, ret: 1n } }, note: 'stdin: you type 16 ⏎  ·  scanf returns 1 in %rax' },
          22: { checkpoint: 'Last line! After it, compare with the answer key: 392 old RBP (RBP) · 384: 16 · 376: return address of the 2nd scanf · 368: 2× return address (RSP).' },
        },
      });
      return { regs: ['rax', 'rsi', 'rdi', 'r12', 'rbp', 'rsp'], syms, S: 400, steps, init };
    },
    outro: 'Answer key: 392 = old RBP (RBP points here), 384 = 16, 376 = return address of the 2nd scanf, 368 = 2× return address of the 1st scanf (RSP points here). The 21 at 368 was overwritten by the very first call — a classic trap. (Here ret₁ + ret₁ shows as “?” since it isn’t a known number.)',
  },
];

export function buildPaper(id) {
  const p = PAPERS.find((x) => x.id === id) || PAPERS[0];
  const b = p.build();
  return {
    kind: 'paper',
    id: p.id,
    title: p.title,
    fn: p.fn,
    argsText: p.argsText,
    question: p.question,
    notes: p.notes,
    outro: p.outro,
    tier: null,
    ...b,
    hi: b.S + 8,
  };
}
