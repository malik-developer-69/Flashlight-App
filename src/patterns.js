// Timing for the SOS signal. One "unit" is the length of a dot.
// International Morse: dash = 3 units, gap inside a letter = 1, between letters = 3, between words = 7.
export function buildSos(unit) {
  const letters = [[1, 1, 1], [3, 3, 3], [1, 1, 1]]; // S, O, S
  const segs = [];
  letters.forEach((letter, li) => {
    letter.forEach((len, i) => {
      segs.push({ on: true, ms: len * unit, kind: len === 1 ? 'dot' : 'dash' });
      if (i < letter.length - 1) segs.push({ on: false, ms: unit });
    });
    segs.push({ on: false, ms: li < 2 ? 3 * unit : 7 * unit });
  });
  const total = segs.reduce((a, s) => a + s.ms, 0);
  return { segs, total };
}

/** Where are we in the pattern after `elapsed` ms? Returns whether the light is on and which mark (0-8) is live. */
export function sosAt(pattern, elapsed) {
  let t = elapsed % pattern.total;
  let mark = -1;
  for (const s of pattern.segs) {
    if (s.on) mark++;
    if (t < s.ms) return { on: s.on, mark: s.on ? mark : -1 };
    t -= s.ms;
  }
  return { on: false, mark: -1 };
}

export function strobeAt(hz, elapsed) {
  return ((elapsed / 1000) * hz) % 1 < 0.5;
}
