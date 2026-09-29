# stackgASM

**Play it: https://stackgasm.octanebula.dev**

Endless trainer for the CSE1400 midterm "trace the stack" question.
You get one x86-64 (AT&T) instruction at a time. Make the stack and registers on the right look like the machine **after** it runs, then press **Enter**.

## Run

```
npm run dev
```

This opens http://localhost:5173 in your browser. There are no dependencies and nothing to install; it only needs Node 18+.
`npm test` runs the simulator and generator checks.

## Modes

- **Endless**: one mistake and it's game over (with an explanation of what went wrong). Difficulty ramps through 4 tiers:
  1. Warm-up: push, pop, mov, add/sub
  2. Frames: locals, `8(%rsp)` / `-16(%rbp)` offsets, epilogues
  3. Bytes & branches: `movb/movw/movl` into slots, `lea`, `cmp` + `jl/jg/…`, `leave`, calls with stack arguments
  4. Exam boss: `scanf`/`printf` leaving stale return addresses, dirty memory, `subq (%rsp), %rsp`, `mulq`, `movzbq`, sub-registers
- **Practice**: no game over. Mistakes are explained and then you continue. You can pin a tier.
- **Past papers**: the 2024 (blinds) and 2025 (scanf) midterm questions, step by step, with the official answer key at the checkpoint.

## Controls

| Do | How |
|---|---|
| Edit a slot or register | click it, type, <kbd>Enter</kbd>. Accepts `42`, `-8`, `0x1f`, `?` (unknown), `old rbp`, `ret0`… |
| Write single bytes (movb…) | type the 8 bytes exam-style, `XXXXXXX 32` or `? ? ? ? ? ? ? 32`, or open the ▦ byte view |
| Move `%rsp` / `%rbp` | drag the arrows, or <kbd>W</kbd>/<kbd>S</kbd> (<kbd>Shift</kbd> for `%rbp`) |
| Copy a value | drag it from a register or slot onto another |
| Push quickly | <kbd>S</kbd> (selects the new top slot), type the value, <kbd>Enter</kbd> <kbd>Enter</kbd> |
| Check | <kbd>Enter</kbd> (or <kbd>Ctrl</kbd>+<kbd>Enter</kbd> inside an input) |
| Jumps | <kbd>T</kbd> taken / <kbd>N</kbd> not taken |
| Undo / cheat sheet | <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>F1</kbd> |

Conventions follow the midterm answer keys: `?` is garbage/unknown, `pop` never erases memory, and a library call leaves its return address below `%rsp`.
