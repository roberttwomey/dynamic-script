/**
 * Myers' online approximate string matching algorithm.
 * ES Module version ported from string-match-browser.js.
 *
 * [1] G. Myers, "A Fast Bit-Vector Algorithm for Approximate String Matching
 *     Based on Dynamic Programming," vol. 46, no. 3, pp. 395–415, 1999.
 */

function reverse(s) {
  return s.split("").reverse().join("");
}

function findMatchStarts(text, pattern, matches) {
  const patRev = reverse(pattern);
  return matches.map((m) => {
    const minStart = Math.max(0, m.end - pattern.length - m.errors);
    const textRev = reverse(text.slice(minStart, m.end));
    const start = findMatchEnds(textRev, patRev, m.errors).reduce((min, rm) => {
      if (m.end - rm.end < min) {
        return m.end - rm.end;
      }
      return min;
    }, m.end);
    return { start, end: m.end, errors: m.errors };
  });
}

function oneIfNotZero(n) {
  return ((n | -n) >> 31) & 1;
}

function advanceBlock(ctx, peq, b, hIn) {
  let pV = ctx.P[b];
  let mV = ctx.M[b];
  const hInIsNegative = hIn >>> 31;
  const eq = peq[b] | hInIsNegative;
  const xV = eq | mV;
  const xH = (((eq & pV) + pV) ^ pV) | eq;
  let pH = mV | ~(xH | pV);
  let mH = pV & xH;
  const hOut =
    oneIfNotZero(pH & ctx.lastRowMask[b]) -
    oneIfNotZero(mH & ctx.lastRowMask[b]);
  pH <<= 1;
  mH <<= 1;
  mH |= hInIsNegative;
  pH |= oneIfNotZero(hIn) - hInIsNegative;
  pV = mH | ~(xV | pH);
  mV = pH & xV;
  ctx.P[b] = pV;
  ctx.M[b] = mV;
  return hOut;
}

function findMatchEnds(text, pattern, maxErrors) {
  if (pattern.length === 0) return [];
  maxErrors = Math.min(maxErrors, pattern.length);
  const matches = [];
  const w = 32;
  const bMax = Math.ceil(pattern.length / w) - 1;
  const ctx = {
    P: new Uint32Array(bMax + 1),
    M: new Uint32Array(bMax + 1),
    lastRowMask: new Uint32Array(bMax + 1),
  };
  ctx.lastRowMask.fill(1 << 31);
  ctx.lastRowMask[bMax] = 1 << ((pattern.length - 1) % w);
  const emptyPeq = new Uint32Array(bMax + 1);
  const peq = new Map();
  const asciiPeq = [];
  for (let i = 0; i < 256; i++) asciiPeq.push(emptyPeq);

  for (let c = 0; c < pattern.length; c++) {
    const val = pattern.charCodeAt(c);
    if (peq.has(val)) continue;
    const charPeq = new Uint32Array(bMax + 1);
    peq.set(val, charPeq);
    if (val < asciiPeq.length) asciiPeq[val] = charPeq;
    for (let b = 0; b <= bMax; b++) {
      charPeq[b] = 0;
      for (let r = 0; r < w; r++) {
        const idx = b * w + r;
        if (idx >= pattern.length) continue;
        if (pattern.charCodeAt(idx) === val) charPeq[b] |= 1 << r;
      }
    }
  }

  let y = Math.max(0, Math.ceil(maxErrors / w) - 1);
  const score = new Uint32Array(bMax + 1);
  for (let b = 0; b <= y; b++) score[b] = (b + 1) * w;
  score[bMax] = pattern.length;
  for (let b = 0; b <= y; b++) {
    ctx.P[b] = ~0;
    ctx.M[b] = 0;
  }

  for (let j = 0; j < text.length; j++) {
    const charCode = text.charCodeAt(j);
    let charPeq =
      charCode < asciiPeq.length
        ? asciiPeq[charCode]
        : peq.get(charCode) || emptyPeq;

    let carry = 0;
    for (let b = 0; b <= y; b++) {
      carry = advanceBlock(ctx, charPeq, b, carry);
      score[b] += carry;
    }

    if (
      score[y] - carry <= maxErrors &&
      y < bMax &&
      (charPeq[y + 1] & 1 || carry < 0)
    ) {
      y++;
      ctx.P[y] = ~0;
      ctx.M[y] = 0;
      let maxBlockScore =
        y === bMax ? (pattern.length % w === 0 ? w : pattern.length % w) : w;
      score[y] =
        score[y - 1] + maxBlockScore - carry + advanceBlock(ctx, charPeq, y, carry);
    } else {
      while (y > 0 && score[y] >= maxErrors + w) y--;
    }

    if (y === bMax && score[y] <= maxErrors) {
      if (score[y] < maxErrors) matches.splice(0, matches.length);
      matches.push({ start: -1, end: j + 1, errors: score[y] });
      maxErrors = score[y];
    }
  }
  return matches;
}

export function approxSearch(text, pattern, maxErrors) {
  const matches = findMatchEnds(text, pattern, maxErrors);
  return findMatchStarts(text, pattern, matches);
}
