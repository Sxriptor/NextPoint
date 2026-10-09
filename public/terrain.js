// World generation: pure data, no three.js, so it also runs in Node for testing.
// Both players run this with the same map seed and get the identical world.
import { createNoise } from './noise.js';
import { mulberry32, smoothstep, lerp, clamp, ROAD_HALF, MAP_HALF } from './shared.js';
import { generateStage } from './stage.js';

export const GRID_STEP = 5; // terrain vertex spacing (m)
const N = Math.round((MAP_HALF * 2) / GRID_STEP) + 1;
const SAMPLE_STEP = 2.5; // road sample spacing (m)
const MAX_RISE = 0.17 * SAMPLE_STEP; // max road grade 17%
const BORDER = 690; // terrain rises into a mountain wall beyond this
const CELL = 16; // spatial hash cell size
const CELLS = Math.ceil((MAP_HALF * 2) / CELL);

// Each theme: base terrain height, plus how strongly terrain is flattened near roads
// (att = [factor at the road, start distance, full-height distance]) so roads sit in valleys.
const THEMES = {
  alpine: {
    att: [0.15, 15, 170],
    base: (nz, x, z) => Math.pow(nz.ridged(x * 0.0028, z * 0.0028, 5), 2.2) * 320 + nz.fbm(x * 0.01 + 50, z * 0.01, 3) * 12,
    ramp: (x, z) => (z + MAP_HALF) * 0.12, // the whole map tilts up toward the summit in the north
  },
  desert: {
    att: [0.1, 10, 90],
    base: (nz, x, z) => {
      const n = nz.fbm(x * 0.0035, z * 0.0035, 4);
      return 10 + smoothstep(-0.05, 0.02, n) * 45 + smoothstep(0.18, 0.22, n) * 35 + nz.fbm(x * 0.02, z * 0.02, 2) * 4;
    },
    ramp: () => 0,
  },
  forest: {
    att: [0.3, 15, 200],
    base: (nz, x, z) => 12 + (nz.fbm(x * 0.004, z * 0.004, 5) * 0.5 + 0.5) * 70 + nz.fbm(x * 0.02, z * 0.02, 2) * 6,
    ramp: () => 0,
    water: 0.5,
  },
  snow: {
    att: [0.3, 15, 200],
    base: (nz, x, z) => 15 + (nz.fbm(x * 0.0035, z * 0.0035, 5) * 0.5 + 0.5) * 95 + nz.fbm(x * 0.02, z * 0.02, 2) * 5,
    ramp: () => 0,
  },
  coast: {
    att: [0.2, 12, 160],
    base: (nz, x, z) => 10 + Math.pow(nz.ridged(x * 0.003, z * 0.003, 4), 2) * 110 + nz.fbm(x * 0.015, z * 0.015, 2) * 6,
    // Land slopes down to the sea, which lies past the map's `sea` direction (unit [x, z]).
    ramp: (x, z, map) => {
      const [sx, sz] = map.sea || [1, 0];
      return (470 - (x * sx + z * sz)) * 0.14;
    },
    water: 0,
  },
  highland: {
    att: [0.35, 20, 220],
    base: (nz, x, z) => 20 + (nz.fbm(x * 0.003, z * 0.003, 5) * 0.5 + 0.5) * 120 + nz.fbm(x * 0.015, z * 0.015, 2) * 8,
    ramp: () => 0,
  },
  // Flat river country for boat stages: low meadows 4–10 m above the water.
  river: {
    att: [1, 0, 1],
    base: (nz, x, z) => 4 + (nz.fbm(x * 0.004, z * 0.004, 4) * 0.5 + 0.5) * 6 + nz.fbm(x * 0.03, z * 0.03, 2) * 0.8,
    ramp: () => 0,
  },
  outback: {
    att: [0.15, 10, 110],
    base: (nz, x, z) => {
      const n = nz.fbm(x * 0.004 + 20, z * 0.004, 4);
      return 6 + (n * 0.5 + 0.5) * 25 + smoothstep(0.16, 0.2, n) * 30 + nz.fbm(x * 0.025, z * 0.025, 2) * 2.5;
    },
    ramp: () => 0,
  },
};

// Hill climbs (`map.climb` meters): the land rises with progress along the main route, so the stage climbs
// the whole way however it wanders. Inverse-distance blend of route progress, sampled on a coarse grid.
function climbField(route, height) {
  if (!height) return () => 0;
  const pts = [];
  for (let i = 0; i < route.length; i += 4) pts.push(route[i].x, route[i].z, (height * i) / (route.length - 1));
  const step = 10, n = (MAP_HALF * 2) / step + 1;
  const f = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -MAP_HALF + i * step, z = -MAP_HALF + j * step;
      let sw = 0, sh = 0;
      for (let k = 0; k < pts.length; k += 3) {
        const d = Math.hypot(pts[k] - x, pts[k + 1] - z) + 15;
        const w = 1 / (d * d * d * d);
        sw += w;
        sh += w * pts[k + 2];
      }
      f[j * n + i] = sh / sw;
    }
  }
  return (x, z) => {
    const gx = clamp((x + MAP_HALF) / step, 0, n - 1.001), gz = clamp((z + MAP_HALF) / step, 0, n - 1.001);
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    return lerp(lerp(f[j * n + i], f[j * n + i + 1], fx), lerp(f[(j + 1) * n + i], f[(j + 1) * n + i + 1], fx), fz);
  };
}

// Props: count, size range, clearance from road edge, collider radius per unit size, placement rule.
const PROP_RULES = {
  alpine: [
    { type: 'pine', count: 2600, size: [0.8, 1.6], clear: 4, r: 0.45, ok: (h, sl, nz, x, z) => sl < 0.75 && h < 250 + nz.fbm(x * 0.01, z * 0.01, 2) * 60 && nz.fbm(x * 0.006 + 9, z * 0.006, 2) > -0.12 },
    { type: 'rock', count: 500, size: [0.6, 3], clear: 4, r: 0.85, ok: () => true },
  ],
  desert: [
    { type: 'cactus', count: 450, size: [0.7, 1.4], clear: 5, r: 0.4, ok: (h, sl) => sl < 0.3 },
    { type: 'rock', count: 500, size: [0.6, 3.5], clear: 4, r: 0.85, ok: () => true },
    { type: 'shrub', count: 800, size: [0.6, 1.3], clear: 3, r: 0, ok: (h, sl) => sl < 0.4 },
  ],
  forest: [
    { type: 'pine', count: 2800, size: [0.9, 1.8], clear: 3, r: 0.45, ok: (h, sl, nz, x, z) => sl < 0.8 && nz.fbm(x * 0.006 + 3, z * 0.006, 2) > -0.2 },
    { type: 'oak', count: 1500, size: [0.8, 1.5], clear: 3.5, r: 0.5, ok: (h, sl, nz, x, z) => sl < 0.6 && nz.fbm(x * 0.006 + 3, z * 0.006, 2) < 0.15 },
    { type: 'rock', count: 250, size: [0.6, 2.5], clear: 4, r: 0.85, ok: () => true },
  ],
  snow: [
    { type: 'snowpine', count: 3000, size: [0.8, 1.7], clear: 3, r: 0.45, ok: (h, sl, nz, x, z) => sl < 0.8 && nz.fbm(x * 0.006 + 5, z * 0.006, 2) > -0.25 },
    { type: 'rock', count: 300, size: [0.6, 2.5], clear: 4, r: 0.85, ok: () => true },
  ],
  coast: [
    { type: 'palm', count: 500, size: [0.8, 1.3], clear: 4, r: 0.35, ok: (h, sl) => h < 40 && sl < 0.45 },
    { type: 'oak', count: 1300, size: [0.6, 1.2], clear: 3.5, r: 0.5, ok: (h, sl, nz, x, z) => sl < 0.6 && nz.fbm(x * 0.007 + 1, z * 0.007, 2) > -0.05 },
    { type: 'shrub', count: 1200, size: [0.6, 1.4], clear: 3, r: 0, ok: (h, sl) => sl < 0.7 },
    { type: 'rock', count: 450, size: [0.6, 3], clear: 4, r: 0.85, ok: () => true },
  ],
  highland: [
    { type: 'shrub', count: 1800, size: [0.6, 1.2], clear: 3, r: 0, ok: (h, sl) => sl < 0.7 },
    { type: 'rock', count: 900, size: [0.5, 3.2], clear: 4, r: 0.85, ok: () => true },
    { type: 'pine', count: 700, size: [0.8, 1.5], clear: 3, r: 0.45, ok: (h, sl, nz, x, z) => sl < 0.6 && nz.fbm(x * 0.008 + 7, z * 0.008, 2) > 0.18 },
  ],
  river: [
    { type: 'reeds', count: 1400, size: [0.7, 1.3], clear: 0.5, r: 0, ok: (h, sl, nz, x, z, nearWater) => nearWater(5) },
    { type: 'oak', count: 1500, size: [0.8, 1.6], clear: 4, r: 0.5, ok: (h, sl, nz, x, z) => sl < 0.6 && nz.fbm(x * 0.006 + 3, z * 0.006, 2) < 0.2 },
    { type: 'pine', count: 1300, size: [0.9, 1.7], clear: 5, r: 0.45, ok: (h, sl, nz, x, z) => sl < 0.7 && nz.fbm(x * 0.006 + 3, z * 0.006, 2) > -0.1 },
    { type: 'shrub', count: 1000, size: [0.6, 1.3], clear: 2, r: 0, ok: (h, sl) => sl < 0.7 },
    { type: 'rock', count: 200, size: [0.6, 2.2], clear: 3, r: 0.85, ok: () => true },
  ],
  outback: [
    { type: 'acacia', count: 550, size: [0.7, 1.3], clear: 4, r: 0.4, ok: (h, sl) => sl < 0.35 },
    { type: 'shrub', count: 1400, size: [0.5, 1.2], clear: 3, r: 0, ok: (h, sl) => sl < 0.5 },
    { type: 'rock', count: 450, size: [0.6, 3], clear: 4, r: 0.85, ok: () => true },
  ],
};

// ---------- Splines ----------
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

// Open Catmull-Rom through ctrl, resampled every SAMPLE_STEP m → [{x, z, tx, tz}].
// `skip` drops leading segments (branches use the previous route point only to shape their start).
export function splineSamples(ctrl, skip = 0) {
  const n = ctrl.length;
  const pts = [
    [2 * ctrl[0][0] - ctrl[1][0], 2 * ctrl[0][1] - ctrl[1][1]],
    ...ctrl,
    [2 * ctrl[n - 1][0] - ctrl[n - 2][0], 2 * ctrl[n - 1][1] - ctrl[n - 2][1]],
  ];
  const dense = [];
  for (let i = 1 + skip; i < pts.length - 2; i++) {
    for (let s = 0; s < 40; s++) dense.push(catmull(pts[i - 1], pts[i], pts[i + 1], pts[i + 2], s / 40));
  }
  dense.push(ctrl[n - 1]);

  const out = [{ x: dense[0][0], z: dense[0][1] }];
  let carry = 0;
  for (let i = 1; i < dense.length; i++) {
    let [ax, az] = dense[i - 1];
    const [bx, bz] = dense[i];
    let seg = Math.hypot(bx - ax, bz - az);
    while (carry + seg >= SAMPLE_STEP) {
      const t = (SAMPLE_STEP - carry) / seg;
      ax += (bx - ax) * t;
      az += (bz - az) * t;
      out.push({ x: ax, z: az });
      seg = Math.hypot(bx - ax, bz - az);
      carry = 0;
    }
    carry += seg;
  }
  for (let i = 0; i < out.length; i++) {
    const a = out[Math.max(0, i - 1)], b = out[Math.min(out.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    out[i].tx = (b.x - a.x) / len;
    out[i].tz = (b.z - a.z) / len;
  }
  return out;
}

function smoothArray(arr, half, passes) {
  let a = arr;
  for (let p = 0; p < passes; p++) {
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) {
      let sum = 0;
      for (let k = -half; k <= half; k++) sum += a[clamp(i + k, 0, a.length - 1)];
      out[i] = sum / (half * 2 + 1);
    }
    a = out;
  }
  return a;
}

function clampGrade(a) {
  for (let i = 1; i < a.length; i++) a[i] = clamp(a[i], a[i - 1] - MAX_RISE, a[i - 1] + MAX_RISE);
  for (let i = a.length - 2; i >= 0; i--) a[i] = clamp(a[i], a[i + 1] - MAX_RISE, a[i + 1] + MAX_RISE);
}

// Coarse (10 m) distance-to-polyline field, bilinearly sampled. Used for valley shaping only.
function coarseField(polys) {
  const step = 10, n = (MAP_HALF * 2) / step + 1;
  const pts = [];
  for (const poly of polys) for (let i = 0; i < poly.length; i += 4) pts.push(poly[i].x, poly[i].z);
  const f = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -MAP_HALF + i * step, z = -MAP_HALF + j * step;
      let best = Infinity;
      for (let k = 0; k < pts.length; k += 2) {
        const dx = pts[k] - x, dz = pts[k + 1] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) best = d2;
      }
      f[j * n + i] = Math.sqrt(best);
    }
  }
  return (x, z) => {
    const gx = clamp((x + MAP_HALF) / step, 0, n - 1.001), gz = clamp((z + MAP_HALF) / step, 0, n - 1.001);
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    const a = f[j * n + i], b = f[j * n + i + 1], c = f[(j + 1) * n + i], d = f[(j + 1) * n + i + 1];
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
  };
}

const cellOf = (v) => clamp(Math.floor((v + MAP_HALF) / CELL), 0, CELLS - 1);

export function generateWorld(map) {
  const theme = THEMES[map.theme];
  const nz = createNoise(map.seed);
  const water = theme.water ?? null;
  // Boat stages: the "road" is a river. Its samples carry the water level, current and rapids.
  const boat = map.vehicle === 'boat';
  const half = map.half ?? ROAD_HALF;

  // ---------- Roads ----------
  const stage = generateStage(map);
  const main = { id: 0, kind: 'main', end: 'finish', s: stage.main };
  const roads = [main];
  stage.branches.forEach((b, k) => roads.push({ id: k + 1, kind: 'wrong', end: b.end, s: b.s, forkIndex: b.forkIndex }));

  // A deep pit just past each cliff ending.
  const pits = roads
    .filter((r) => r.end === 'cliff')
    .map((r) => {
      const e = r.s[r.s.length - 1];
      const off = boat ? 30 : 55; // waterfalls drop right at the end of the channel
      return { x: e.x + e.tx * off, z: e.z + e.tz * off };
    });

  const roadDist = coarseField(roads.map((r) => r.s));
  const river = map.river ? splineSamples(map.river) : null;
  const riverDist = river ? coarseField([river]) : null;
  const [attMin, att0, att1] = theme.att;
  const lift = climbField(stage.main, map.climb);

  // Natural terrain height before the roads are cut in.
  const natural = (x, z) => {
    let h = theme.ramp(x, z, map) + lift(x, z) + theme.base(nz, x, z) * lerp(attMin, 1, smoothstep(att0, att1, roadDist(x, z)));
    if (riverDist) h = lerp(-3, h, smoothstep(10, 34, riverDist(x, z)));
    for (const p of pits) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < 42) h -= 90 * (1 - smoothstep(22, 42, d));
    }
    const e = Math.max(Math.abs(x), Math.abs(z)) - BORDER;
    if (e > 0) h += e * 1.2 + e * e * 0.02;
    return h;
  };

  // ---------- Road elevation profiles ----------
  if (boat) {
    // The water drops gently toward the finish; side channels sit level with where they leave the river.
    main.s.forEach((p, i) => (p.h = p.raw = 1.5 * (1 - i / (main.s.length - 1))));
    for (const r of roads) if (r.kind === 'wrong') r.s.forEach((p) => (p.h = p.raw = main.s[r.forkIndex].h));
  }
  for (const r of boat ? [] : roads) {
    const raw = r.s.map((p) => natural(p.x, p.z));
    // Light smoothing only: rally roads rise and dip with the land.
    let h = smoothArray(raw, 6, 2);
    clampGrade(h);
    h = smoothArray(h, 2, 1);
    // Small bumps so it never feels like a motorway.
    for (let i = 0; i < h.length; i++) h[i] += nz.noise(i * 0.31, r.id * 17.3) * 0.22;
    r.s.forEach((p, i) => {
      p.raw = raw[i];
      p.h = water != null ? Math.max(h[i], water + 2.5) : h[i];
    });
  }
  // Crests: a ramp up then a sharp drop, so the car takes off at speed.
  const crestRng = mulberry32(map.seed * 13 + 1);
  const crests = stage.crests.map((c) => {
    const height = 2.6 + crestRng() * 1.6;
    for (let i = c - 9; i <= c + 10; i++) {
      if (i < 0 || i >= main.s.length) continue;
      const up = smoothstep(c - 9, c, i), down = 1 - smoothstep(c + 1, c + 10, i);
      main.s[i].h += height * (i <= c ? up : down);
    }
    return main.s[c];
  });
  // Branches start exactly at the main road's height, blending into their own profile.
  for (const r of roads) {
    if (r.kind !== 'wrong') continue;
    const off = main.s[r.forkIndex].h - r.s[0].h;
    r.s.forEach((p, i) => (p.h += off * (1 - smoothstep(0, 40, i))));
  }
  // Where the road runs well above the natural ground it becomes a bridge.
  for (const r of roads) {
    const high = r.s.map((p) => p.h - p.raw > 4);
    r.s.forEach((p, i) => {
      p.bridge = false;
      for (let k = -2; k <= 2; k++) if (high[i + k]) p.bridge = true;
    });
  }

  // ---------- River current, rapids and rocks ----------
  const rapids = [], riverRocks = [];
  if (boat) {
    const rr = mulberry32(map.seed * 17 + 5);
    const n = main.s.length;
    const forks = roads.filter((r) => r.kind === 'wrong').map((r) => r.forkIndex);
    for (let i = 70 + Math.floor(rr() * 40); i < n - 70; i += 110 + Math.floor(rr() * 80)) {
      if (forks.some((f) => Math.abs(f - i) < 30)) continue;
      rapids.push(i);
    }
    // Rocks across the channel with one clear gap (≥ 6.5 m) somewhere in each rapid.
    const rock = (p, o, size) => {
      const v = rr();
      const x = p.x + p.tz * o, z = p.z - p.tx * o;
      const y = p.h - size * 0.15 - size * (0.5 + v * 0.5) + 0.35 + size * 0.4; // top pokes 0.4–1.1 m out
      riverRocks.push({ x, z, y, s: size, v, level: p.h });
    };
    for (const zi of rapids) {
      const gap = (rr() * 2 - 1) * (half - 4);
      for (let k = 0, count = 2 + Math.floor(rr() * 3); k < count; k++) {
        for (let tries = 0; tries < 10; tries++) {
          const size = 0.9 + rr() * 0.9, o = (rr() * 2 - 1) * (half - 0.8);
          if (Math.abs(o - gap) < 3.25 + size) continue;
          rock(main.s[zi + Math.round((rr() - 0.5) * 10)], o, size);
          break;
        }
      }
    }
    // A few lone rocks near the banks.
    for (let k = 0; k < 14; k++) {
      const i = 40 + Math.floor(rr() * (n - 100));
      rock(main.s[i], (rr() < 0.5 ? -1 : 1) * (half - 1.2 - rr() * 1.5), 0.6 + rr() * 0.6);
    }
    main.s.forEach((p, i) => {
      p.rapid = rapids.reduce((m, zi) => Math.max(m, 1 - Math.abs(i - zi) / 14), 0);
      p.flow = 2.2 + 3.3 * p.rapid;
    });
    // Side channels: lazy current, except the ones that end in a waterfall, which pull you toward the lip.
    for (const r of roads) {
      if (r.kind !== 'wrong') continue;
      const len = r.s.length;
      r.s.forEach((p, i) => {
        const pull = r.end === 'cliff' ? smoothstep(len - 60, len, i) : 0;
        p.rapid = pull * 0.8;
        p.flow = 2.2 + 5 * pull;
      });
    }
  }

  // ---------- Road spatial hash ----------
  const roadGrid = Array.from({ length: CELLS * CELLS }, () => []);
  for (const r of roads) r.s.forEach((p, i) => roadGrid[cellOf(p.z) * CELLS + cellOf(p.x)].push(r, i));

  // Nearest point on any road within maxR → { road, i, d, h, bridge } or null.
  function nearestRoad(x, z, maxR) {
    const rc = Math.ceil(maxR / CELL), cx = cellOf(x), cz = cellOf(z);
    let best = null, bi = 0, bd = maxR * maxR;
    for (let iz = Math.max(0, cz - rc); iz <= Math.min(CELLS - 1, cz + rc); iz++) {
      for (let ix = Math.max(0, cx - rc); ix <= Math.min(CELLS - 1, cx + rc); ix++) {
        const cell = roadGrid[iz * CELLS + ix];
        for (let k = 0; k < cell.length; k += 2) {
          const p = cell[k].s[cell[k + 1]];
          const dx = p.x - x, dz = p.z - z, d2 = dx * dx + dz * dz;
          if (d2 < bd) {
            bd = d2;
            best = cell[k];
            bi = cell[k + 1];
          }
        }
      }
    }
    if (!best) return null;
    const s = best.s;
    let d = Math.sqrt(bd), h = s[bi].h, idx = bi;
    for (let j = bi - 1; j <= bi; j++) {
      if (j < 0 || j + 1 >= s.length) continue;
      const a = s[j], b = s[j + 1];
      const abx = b.x - a.x, abz = b.z - a.z;
      const t = clamp(((x - a.x) * abx + (z - a.z) * abz) / (abx * abx + abz * abz), 0, 1);
      const dd = Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t));
      if (dd < d) {
        d = dd;
        h = a.h + (b.h - a.h) * t;
        idx = t < 0.5 ? j : j + 1;
      }
    }
    return { road: best, i: idx, d, h, bridge: s[idx].bridge };
  }

  // ---------- Terrain heightfield (roads cut in, embankments filled) ----------
  const H = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -MAP_HALF + i * GRID_STEP, z = -MAP_HALF + j * GRID_STEP;
      const a = natural(x, z);
      const q = nearestRoad(x, z, half + 30);
      let h = a;
      if (q && boat) {
        // River channel: bed shelving up to the edges, a short muddy bank, then the meadow.
        const land = lerp(Math.max(a, q.h + 1.3), a, smoothstep(half + 6, half + 30, q.d));
        h = q.d < half ? q.h - 2.4 + smoothstep(half - 4, half, q.d) * 1.6 : lerp(q.h - 0.8, land, smoothstep(half, half + 5, q.d));
        const s = q.road.s, e = s[s.length - 1];
        if (q.road.end === 'cliff' && q.i >= s.length - 3 && (x - e.x) * e.tx + (z - e.z) * e.tz > -1) h = Math.min(h, a);
      } else if (q) {
        h = lerp(q.h - 0.35, a, smoothstep(ROAD_HALF + 3, ROAD_HALF + 30, q.d));
        if (q.bridge) h = Math.min(h, a); // keep the gap under bridges
      }
      H[j * N + i] = h;
    }
  }

  // Exact height of the rendered terrain triangles (same split as the mesh: diagonal v10–v01).
  function terrainHeight(x, z) {
    const gx = clamp((x + MAP_HALF) / GRID_STEP, 0, N - 1.0001), gz = clamp((z + MAP_HALF) / GRID_STEP, 0, N - 1.0001);
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    const h00 = H[j * N + i], h10 = H[j * N + i + 1], h01 = H[(j + 1) * N + i], h11 = H[(j + 1) * N + i + 1];
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  // Drivable surface: road deck where on the road, terrain elsewhere (blended at the road edge).
  function surface(x, z) {
    const t = terrainHeight(x, z);
    const q = nearestRoad(x, z, half + 2.5);
    if (!q) return { h: t, road: null, q: null };
    if (q.d <= half) return { h: q.h, road: q.road, q };
    if (q.bridge) return { h: t, road: null, q };
    return { h: lerp(q.h, t, (q.d - half) / 2.5), road: null, q };
  }

  // ---------- Colliders ----------
  const colGrid = Array.from({ length: CELLS * CELLS }, () => []);
  const addCollider = (x, y, z, r, rail = false) => colGrid[cellOf(z) * CELLS + cellOf(x)].push({ x, y, z, r, rail });
  // Solid guard rails along bridges.
  for (const r of roads) {
    r.s.forEach((p, i) => {
      if (!p.bridge || i % 2) return;
      for (const side of [-1, 1]) {
        const o = (half + 0.3) * side;
        addCollider(p.x + p.tz * o, p.h, p.z - p.tx * o, 0.25, true);
      }
    });
  }
  function queryColliders(x, z, fn) {
    const cx = cellOf(x), cz = cellOf(z);
    for (let iz = Math.max(0, cz - 1); iz <= Math.min(CELLS - 1, cz + 1); iz++) {
      for (let ix = Math.max(0, cx - 1); ix <= Math.min(CELLS - 1, cx + 1); ix++) {
        for (const c of colGrid[iz * CELLS + ix]) fn(c);
      }
    }
  }

  // ---------- Props ----------
  const rng = mulberry32(map.seed * 7 + 3);
  const slopeAt = (x, z) =>
    Math.hypot(terrainHeight(x + 2, z) - terrainHeight(x - 2, z), terrainHeight(x, z + 2) - terrainHeight(x, z - 2)) / 4;
  const props = [];
  for (const rule of PROP_RULES[map.theme]) {
    let placed = 0;
    for (let t = 0; placed < rule.count && t < rule.count * 8; t++) {
      const x = (rng() * 2 - 1) * 760, z = (rng() * 2 - 1) * 760;
      const s = rule.size[0] + rng() * (rule.size[1] - rule.size[0]);
      const rot = rng() * Math.PI * 2, v = rng();
      const h = terrainHeight(x, z);
      if (water != null && h < water + 1) continue;
      if (nearestRoad(x, z, half + rule.clear)) continue;
      if (!rule.ok(h, slopeAt(x, z), nz, x, z, (r) => !!nearestRoad(x, z, half + r))) continue;
      props.push({ type: rule.type, x, y: h, z, s, rot, v });
      if (rule.r) addCollider(x, h, z, rule.r * s);
      placed++;
    }
  }

  for (const r of riverRocks) {
    props.push({ type: 'rock', x: r.x, y: r.y, z: r.z, s: r.s, rot: r.v * 6.28, v: r.v });
    addCollider(r.x, r.level, r.z, 0.85 * r.s);
  }

  // ---------- Dead-end barriers, finish, start ----------
  const deadEnds = roads
    .filter((r) => r.end === 'deadend')
    .map((r) => {
      const e = r.s[r.s.length - 2];
      const n = Math.ceil(half / 2);
      for (let k = -n; k <= n; k++) addCollider(e.x + e.tz * k * 2, e.h, e.z - e.tx * k * 2, 1.0);
      return e;
    });
  const finish = main.s[main.s.length - 1];
  for (const side of [-1, 1]) {
    const o = (half + 0.8) * side;
    addCollider(finish.x + finish.tz * o, finish.h, finish.z - finish.tx * o, 0.4);
  }

  return {
    map,
    vehicle: boat ? 'boat' : 'car',
    half,
    rapids: rapids.map((i) => main.s[i]),
    riverRocks,
    crests,
    pieces: stage.pieces,
    N,
    H,
    roads,
    main,
    river,
    water,
    pits,
    props,
    deadEnds,
    finish,
    startIndex: 6,
    terrainHeight,
    surface,
    nearestRoad,
    queryColliders,
  };
}
