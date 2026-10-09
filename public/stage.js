// Rally stage generator: lays the route out of rally "pieces" (square 90s, hairpins, esses, short blasts)
// with a turtle, steering loosely toward the map's guide waypoints, never crossing itself.
// Then it adds wrong-turn branches at junctions and picks crests for jumps. Pure JS, deterministic per seed.
import { mulberry32, angleDiff } from './shared.js';

export const STEP = 2.5; // sample spacing (m)
const BOUND = 600; // keep the route inside ±BOUND
const SELF_GAP = 34; // min distance between non-adjacent parts of the route (m)
const SELF_SKIP = 90; // ...except within the last this-many samples, where only overlap is banned
const LEG_GAP = 13; // so hairpin legs can sit close but never overlap
const CELL = 20;

export const STYLES = {
  alpine: {
    length: [3000, 3800],
    weights: { straight: 2, sweeper: 1.5, corner: 3, hairpin: 3.5, esses: 2 },
    straight: [20, 75],
    crests: 5,
    forks: 6,
    cliffs: true,
  },
  desert: {
    length: [3200, 4000],
    weights: { straight: 5, sweeper: 3, corner: 2.5, hairpin: 0.8, esses: 2 },
    straight: [40, 140],
    crests: 12,
    forks: 6,
    cliffs: true,
  },
  forest: {
    length: [2900, 3600],
    weights: { straight: 2, sweeper: 1, corner: 3.5, hairpin: 1, esses: 4.5 },
    straight: [20, 65],
    crests: 9,
    forks: 6,
    cliffs: false,
  },
  // Hill climbs: short, hairpin-stacked, always going up (the climb itself comes from the map's `lift`).
  hillclimb: {
    length: [2300, 2900],
    weights: { straight: 1.5, sweeper: 1, corner: 3, hairpin: 5, esses: 2.5 },
    straight: [18, 60],
    crests: 3,
    forks: 5,
    cliffs: true,
  },
  // Fast and open: long blasts, big sweepers, lots of crests (moors, outback).
  flowing: {
    length: [3400, 4200],
    weights: { straight: 5, sweeper: 4.5, corner: 1.5, hairpin: 0.4, esses: 1.5 },
    straight: [50, 150],
    crests: 14,
    forks: 6,
    cliffs: false,
  },
  // Slow and twisty: barely a straight, corner after corner.
  technical: {
    length: [2700, 3300],
    weights: { straight: 1, sweeper: 0.8, corner: 4.5, hairpin: 2, esses: 4 },
    straight: [15, 45],
    crests: 6,
    forks: 7,
    cliffs: false,
  },
  // River (boat stages): a wide channel, so bends are wider and parallel reaches sit further apart.
  // radiusScale widens corner/hairpin/esses arcs; gap/legGap/branchGap are SELF_GAP/LEG_GAP/branch clearance.
  river: {
    length: [3000, 3600],
    weights: { straight: 3, sweeper: 4, corner: 2.5, hairpin: 0.7, esses: 3.5 },
    straight: [30, 110],
    radiusScale: 2,
    gap: 60,
    legGap: 30,
    branchGap: 42,
    crests: 0,
    forks: 5,
    cliffs: true, // on a river, a "cliff" ending is a waterfall
  },
  // Coastal tarmac: corners and sweepers along the shore.
  coast: {
    length: [3000, 3800],
    weights: { straight: 2.5, sweeper: 3, corner: 3, hairpin: 1.2, esses: 2.5 },
    straight: [25, 90],
    crests: 6,
    forks: 6,
    cliffs: true,
  },
};

function pick(rng, weights) {
  const entries = Object.entries(weights);
  let r = rng() * entries.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of entries) if ((r -= w) <= 0) return k;
  return entries[0][0];
}

// Pieces are lists of primitives: ['S', length] or ['A', radius, signedAngle]. Positive angle turns toward +x.
function piece(type, rng, style, sign) {
  const R = (a, b) => a + rng() * (b - a);
  const rs = style.radiusScale || 1;
  switch (type) {
    case 'straight':
      return [['S', R(...style.straight)]];
    case 'sweeper':
      return [['A', R(40, 80), sign * R(0.35, 0.8)]];
    case 'corner': // square-ish 90
      return [['S', R(12, 30)], ['A', R(7, 14) * rs, sign * R(1.35, 1.75)], ['S', R(8, 20)]];
    case 'hairpin':
      return [['S', R(12, 30)], ['A', R(7.5, 10) * rs, sign * R(2.8, 3.25)], ['S', R(8, 20)]];
    case 'esses': {
      const out = [];
      let s = sign;
      for (let i = 0, n = rng() < 0.4 ? 3 : 2; i < n; i++, s = -s) out.push(['A', R(13, 28) * rs, s * R(0.6, 1.25)]);
      out.push(['S', R(8, 20)]);
      return out;
    }
  }
}

// Walks the primitives from a start pose. Straights get a slight random wobble so nothing is ruler-straight.
function trace(start, prims, rng) {
  let { x, z, h } = start;
  const pts = [];
  for (const [kind, a, b] of prims) {
    if (kind === 'S') {
      for (let i = 0, n = Math.max(1, Math.round(a / STEP)); i < n; i++) {
        h += (rng() - 0.5) * 0.012;
        x += Math.sin(h) * STEP;
        z += Math.cos(h) * STEP;
        pts.push({ x, z, h });
      }
    } else {
      const n = Math.max(2, Math.round((Math.abs(b) * a) / STEP));
      const dh = b / n;
      for (let i = 0; i < n; i++) {
        h += dh / 2;
        x += Math.sin(h) * STEP;
        z += Math.cos(h) * STEP;
        h += dh / 2;
        pts.push({ x, z, h });
      }
    }
  }
  return pts;
}

// Spatial grid of placed samples: {road, i, x, z}
function makeGrid() {
  const cells = new Map();
  const key = (x, z) => Math.floor(x / CELL) * 100003 + Math.floor(z / CELL);
  return {
    add(p) {
      const k = key(p.x, p.z);
      (cells.get(k) || cells.set(k, []).get(k)).push(p);
    },
    remove(p) {
      const arr = cells.get(key(p.x, p.z));
      const i = arr ? arr.indexOf(p) : -1;
      if (i >= 0) arr.splice(i, 1);
    },
    // true if any sample within r passes `blocks(sample)`
    near(x, z, r, blocks) {
      const c = Math.ceil(r / CELL), cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      for (let ix = cx - c; ix <= cx + c; ix++) {
        for (let iz = cz - c; iz <= cz + c; iz++) {
          const arr = cells.get(ix * 100003 + iz);
          if (!arr) continue;
          for (const p of arr) {
            const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
            if (d2 < r * r && blocks(p, Math.sqrt(d2))) return true;
          }
        }
      }
      return false;
    },
  };
}

const inBounds = (p, b = BOUND) => Math.abs(p.x) < b && Math.abs(p.z) < b;
const toSample = ({ x, z, h }) => ({ x, z, tx: Math.sin(h), tz: Math.cos(h) });

export function generateStage(map) {
  // A map picks a style (defaults to its theme's) and can override any field of it.
  const style = { ...(STYLES[map.style] || STYLES[map.theme] || STYLES.forest), ...map.tweak };
  const rng = mulberry32(map.seed * 31 + 7);
  const guide = map.guide;
  const grid = makeGrid();
  const selfGap = style.gap ?? SELF_GAP, legGap = style.legGap ?? LEG_GAP, branchGap = style.branchGap ?? 30;

  // ---------- Main route ----------
  const [gx0, gz0] = guide[0], [gx1, gz1] = guide[1];
  const start = { x: gx0, z: gz0, h: Math.atan2(gx1 - gx0, gz1 - gz0) };
  const main = [start];
  grid.add({ road: 0, i: 0, x: start.x, z: start.z });
  const segs = []; // { type, from, to, prims }
  let wp = 1, fails = 0;
  const maxLen = style.length[1] / STEP, minLen = style.length[0] / STEP;

  const fits = (pts, base) =>
    pts.every((p, k) =>
      inBounds(p) &&
      !grid.near(p.x, p.z, selfGap, (q, d) => {
        const age = base + k - q.i;
        return age > SELF_SKIP || (age > 14 && d < legGap);
      }),
    );

  for (let guard = 0; guard < 4000 && main.length < maxLen; guard++) {
    const cur = main[main.length - 1];
    while (wp < guide.length - 1 && Math.hypot(guide[wp][0] - cur.x, guide[wp][1] - cur.z) < 130) wp++;
    const [tx, tz] = guide[wp];
    if (wp === guide.length - 1 && main.length > minLen && Math.hypot(tx - cur.x, tz - cur.z) < 150) break;
    const diff = angleDiff(cur.h, Math.atan2(tx - cur.x, tz - cur.z));
    const toward = Math.sign(diff) || 1;

    // Bias the piece mix by how far we are off the guide heading.
    const weights = { ...style.weights };
    if (Math.abs(diff) < 0.4) weights.hairpin *= 0.2;
    if (Math.abs(diff) > 1.6) {
      weights.straight *= 0.3;
      weights.corner *= 1.5;
    }

    let placed = false;
    for (let attempt = 0; attempt < 8 && !placed; attempt++) {
      const type = pick(rng, weights);
      const sign = rng() < 0.72 ? toward : -toward;
      const prims = piece(type, rng, style, sign);
      const pts = trace(cur, prims, rng);
      if (!fits(pts, main.length)) continue;
      const from = main.length;
      for (const p of pts) {
        grid.add((p.g = { road: 0, i: main.length, x: p.x, z: p.z }));
        main.push(p);
      }
      segs.push({ type, from, to: main.length - 1, prims });
      placed = true;
    }
    if (!placed) {
      // Boxed in: back up one piece and try something else.
      if (!segs.length || ++fails > 800) break;
      const s = segs.pop();
      for (const p of main.splice(s.from)) grid.remove(p.g);
    }
  }
  // Finish straight
  const tail = trace(main[main.length - 1], [['S', 40]], rng).filter((p) => inBounds(p, BOUND + 60));
  main.push(...tail);
  const mainSamples = main.map(toSample);
  for (const p of tail) grid.add({ road: 0, i: main.indexOf(p), x: p.x, z: p.z });

  // ---------- Wrong-turn branches ----------
  const forkCands = [];
  for (const s of segs) {
    if (s.type === 'corner' || s.type === 'hairpin') {
      // Wrong road carries straight on where the route turns.
      const at = s.from + Math.round(s.prims[0][1] / STEP);
      forkCands.push({ at, dh: 0 });
    } else if (s.type === 'straight' && s.to - s.from > 20) {
      const at = Math.round((s.from + s.to) / 2);
      forkCands.push({ at, dh: (rng() < 0.5 ? -1 : 1) * (0.55 + rng() * 0.45) });
    }
  }
  for (let i = forkCands.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [forkCands[i], forkCands[j]] = [forkCands[j], forkCands[i]];
  }

  const branches = [];
  const usedAt = [];
  for (const cand of forkCands) {
    if (branches.length >= style.forks) break;
    if (cand.at < 60 || cand.at > main.length - 100) continue;
    if (usedAt.some((a) => Math.abs(a - cand.at) < 110)) continue;
    const base = main[cand.at];
    const R = (a, b) => a + rng() * (b - a);
    const prims = [['S', R(45, 80)]];
    for (let k = 0, n = 1 + Math.floor(rng() * 2); k < n; k++) {
      prims.push(...piece(pick(rng, { sweeper: 2, corner: 2, esses: 2, straight: 1 }), rng, style, rng() < 0.5 ? 1 : -1));
    }
    prims.push(['S', R(20, 50)]);
    const pts = trace({ x: base.x, z: base.z, h: base.h + cand.dh }, prims, rng);
    const id = branches.length + 1;
    const ok = pts.every(
      (p, k) =>
        inBounds(p) &&
        !grid.near(p.x, p.z, branchGap, (q) => (q.road === 0 ? k >= 40 || Math.abs(q.i - cand.at) > 50 : true)),
    );
    if (!ok) continue;

    // Cliff endings need empty space past the end for the drop.
    const e = pts[pts.length - 1];
    const pit = { x: e.x + Math.sin(e.h) * 55, z: e.z + Math.cos(e.h) * 55 };
    const cliffOk = style.cliffs && rng() < 0.55 && inBounds(pit, BOUND + 40) && !grid.near(pit.x, pit.z, 80, () => true);
    for (const [k, p] of pts.entries()) grid.add({ road: id, i: k, x: p.x, z: p.z });
    branches.push({
      s: [toSample(base), ...pts.map(toSample)],
      forkIndex: cand.at,
      end: cliffOk ? 'cliff' : 'deadend',
    });
    usedAt.push(cand.at);
  }

  // ---------- Crests (jumps) on straights, away from forks ----------
  const crestCands = segs
    .filter((s) => (s.type === 'straight' && s.to - s.from >= 14) || s.type === 'sweeper')
    .map((s) => s.from + Math.floor((s.to - s.from) * 0.65))
    .filter((c) => !usedAt.some((a) => Math.abs(a - c) < 25));
  const crests = [];
  while (crestCands.length && crests.length < style.crests) {
    const c = crestCands.splice(Math.floor(rng() * crestCands.length), 1)[0];
    if (crests.every((o) => Math.abs(o - c) > 50)) crests.push(c);
  }
  crests.sort((a, b) => a - b);

  return { main: mainSamples, branches, crests, pieces: segs.map((s) => s.type) };
}
