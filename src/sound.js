// Tiny synthesized sound effects (no audio files).
let ctx = null;
function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
function beep(freq, dur, type = 'sine', vol = 0.05, when = 0) {
  const c = ac();
  if (!c) return;
  const t = c.currentTime + when;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sound = {
  enabled: true,
  ok(streak = 0) {
    if (!this.enabled) return;
    const base = 520 * Math.pow(2, Math.min(streak, 24) / 24);
    beep(base, 0.07, 'triangle', 0.045);
    beep(base * 1.5, 0.1, 'triangle', 0.035, 0.055);
  },
  bad() {
    if (!this.enabled) return;
    beep(196, 0.16, 'sawtooth', 0.03);
    beep(131, 0.28, 'sawtooth', 0.03, 0.11);
  },
  done() {
    if (!this.enabled) return;
    [0, 4, 7, 12].forEach((s, i) => beep(523 * 2 ** (s / 12), 0.13, 'triangle', 0.04, i * 0.07));
  },
  tick() {
    if (!this.enabled) return;
    beep(1200, 0.018, 'square', 0.01);
  },
};
