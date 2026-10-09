// Jet-boat physics on the river. Same interface as createSim (physics.js) so main.js can swap it in.
// The river is the stage "road": each sample has a water level `h`, a current speed `flow` and a `rapid` (0..1).
// The boat floats on a spring, is pushed by the current, slides on a keel, and bounces off banks and rocks.
// Runs only on the driver's machine.
import { MAP_HALF } from './shared.js';
import { IDLE } from './physics.js';

const MASS = 1000; // kg
const THRUST = 11000; // N at full throttle → top speed ~22 m/s through the water
const BRAKE_THRUST = 8000; // reverse bucket while still moving forward
const REV_THRUST = 4500;
const DRAG_Q = 20, DRAG_L = 60;
const KEEL = 4.5, KEEL_SLIDE = 0.9; // sideways damping (1/s); Space drops the keel grip for a power slide
const MAX_YAW = 1.15; // rad/s at full lock
const BEAM = 1.3; // centerline to bank contact (m)
const BOAT_R = 1.5; // rock collision radius
const VERT_G = 17;
const LIMIT = MAP_HALF - 20;
const SUBSTEP = 1 / 240;

export function createBoatSim(world) {
  const half = world.half;
  const c = {
    x: 0, y: 0, z: 0, h: 0, vx: 0, vz: 0, vy: 0, wr: 0, fwd: 0, steer: 0, pitch: 0, roll: 0,
    grounded: true, airTime: 0, onRoad: true, throttle: 0, pedal: 0, ax: 0,
    gear: 2, rpm: IDLE, auto: true, rapid: 0,
  };
  const events = [];
  let t = 0;

  // Small swell everywhere, choppy standing waves in rapids.
  const bob = (x, z, rapid) =>
    0.05 * Math.sin(0.7 * x + 1.3 * t) + 0.04 * Math.sin(0.9 * z - 1.7 * t) +
    rapid * 0.2 * Math.sin(2.1 * x + 5 * t) * Math.sin(1.7 * z + 4.3 * t);

  // Where we are on the river: nearest sample, lateral offset, and whether we're past a waterfall lip.
  function water(x, z) {
    const q = world.nearestRoad(x, z, half + 14);
    if (!q) return null;
    const s = q.road.s, p = s[q.i], e = s[s.length - 1];
    const lat = (x - p.x) * p.tz - (z - p.z) * p.tx; // + is the river's right bank
    const along = (x - p.x) * p.tx + (z - p.z) * p.tz;
    const pastEnd = (x - e.x) * e.tx + (z - e.z) * e.tz > 0 && q.i >= s.length - 3;
    const over = q.road.end === 'cliff' && pastEnd;
    return {
      q, p, lat, over,
      start: q.road.kind === 'main' && q.i === 0 && along < 0,
      end: pastEnd && !over,
      level: q.h,
    };
  }

  function place(x, z, h) {
    const w = water(x, z);
    const rapid = w?.p.rapid || 0;
    const y = w && !w.over ? w.level + bob(x, z, rapid) : world.terrainHeight(x, z);
    Object.assign(c, {
      x, z, h, y, vx: 0, vz: 0, vy: 0, wr: 0, fwd: 0, steer: 0, pitch: 0, roll: 0, grounded: true, airTime: 0,
      pedal: 0, throttle: 0, ax: 0, gear: 2, rpm: IDLE,
    });
  }

  // Bounce off something along outward normal (nx, nz).
  function bounce(nx, nz, keep) {
    const vn = c.vx * nx + c.vz * nz;
    if (vn <= 0) return;
    if (vn > 4) events.push({ type: 'hit', strength: vn * 1.6 });
    c.vx = (c.vx - 1.4 * vn * nx) * keep;
    c.vz = (c.vz - 1.4 * vn * nz) * keep;
    c.wr *= 0.6;
  }

  function substep(dt, inp) {
    t += dt;
    const w = water(c.x, c.z);
    const fx = Math.sin(c.h), fz = Math.cos(c.h);
    const rx = -fz, rz = fx; // boat's right
    c.steer += (inp.steer - c.steer) * Math.min(1, dt * (Math.abs(inp.steer) > Math.abs(c.steer) ? 9 : 14));
    c.pedal = inp.throttle > c.pedal ? Math.min(inp.throttle, c.pedal + dt * 5) : inp.throttle;
    const throttle = c.pedal, brake = inp.brake;

    const wet = w && !w.over;
    const rapid = wet ? w.p.rapid || 0 : 0;
    c.rapid = rapid;
    const surfaceY = wet ? w.level + bob(c.x, c.z, rapid) : -Infinity;
    const floating = wet && c.y <= surfaceY + 0.25;
    c.grounded = c.onRoad = floating;

    // Engine note: revs follow the throttle and how hard the jet is working.
    const uGround = c.vx * fx + c.vz * fz;
    const rpmTarget = IDLE + (throttle + brake * 0.7) * 4200 + Math.abs(uGround) * 110 * (throttle || brake ? 1 : 0.4);
    c.rpm += (Math.min(7400, rpmTarget) - c.rpm) * Math.min(1, dt * (throttle ? 6 : 3));
    c.throttle = Math.max(throttle, brake * 0.6);

    if (inp.hold) {
      // Tied up at the start line / stopped after the finish.
      c.vx = c.vz = c.wr = 0;
    } else if (floating) {
      c.airTime = 0;
      // Velocity relative to the water: the current carries the boat downstream.
      const cur = w.p.flow || 0, cx = w.p.tx * cur, cz = w.p.tz * cur;
      const wx = c.vx - cx, wz = c.vz - cz;
      let u = wx * fx + wz * fz, v = wx * rx + wz * rz;

      let F = THRUST * throttle;
      if (brake) F -= (u > 1 ? BRAKE_THRUST : REV_THRUST) * brake;
      F -= DRAG_Q * u * Math.abs(u) + DRAG_L * u;
      u += (F / MASS) * dt;
      v -= v * Math.min(1, dt * (inp.hand ? KEEL_SLIDE : KEEL));
      c.ax += (F / MASS - c.ax) * Math.min(1, dt * 4);
      c.gear = u < -0.5 || (brake && u < 1) ? 0 : 2;

      // Jet steering: needs water through the hull or thrust through the nozzle.
      const auth = Math.min(1, (Math.abs(u) + throttle * 4) / 7) * (u < -0.5 ? -1 : 1);
      const wrTarget = (c.steer * MAX_YAW * auth * (inp.hand ? 1.35 : 1)) / (1 + Math.max(0, Math.abs(u) - 10) * 0.04);
      c.wr += (wrTarget - c.wr) * Math.min(1, dt * 3);

      c.vx = cx + fx * u + rx * v;
      c.vz = cz + fz * u + rz * v;

      // Hull attitude: nose up when planing and under power, leans into turns, rides the waves.
      const fore = bob(c.x + fx * 2.5, c.z + fz * 2.5, rapid) - bob(c.x - fx * 2.5, c.z - fz * 2.5, rapid);
      const side = bob(c.x - rx, c.z - rz, rapid) - bob(c.x + rx, c.z + rz, rapid);
      const plane = Math.min(1, Math.max(0, u) / 12);
      const pt = -0.05 * plane - c.ax * 0.004 - Math.atan2(fore, 5);
      const rt = Math.max(-0.22, Math.min(0.22, u * c.wr * 0.012)) + Math.atan2(side, 2.2);
      c.pitch += (pt - c.pitch) * Math.min(1, dt * 5);
      c.roll += (rt - c.roll) * Math.min(1, dt * 5);
    } else {
      // In the air: off a rapid's wave or over the falls.
      c.airTime += dt;
      c.wr *= 1 - 0.3 * dt;
      c.pitch += (Math.max(-0.6, Math.min(0.6, -c.vy * 0.03)) - c.pitch) * Math.min(1, 1.5 * dt);
      c.roll *= 1 - Math.min(1, 1.5 * dt);
    }
    c.fwd = c.vx * fx + c.vz * fz;
    c.h -= c.wr * dt;
    c.x += c.vx * dt;
    c.z += c.vz * dt;

    // Banks and the ends of channels.
    if (wet) {
      const p = w.p, lim = half - BEAM;
      if (Math.abs(w.lat) > lim) {
        const s = Math.sign(w.lat), nx = p.tz * s, nz = -p.tx * s;
        const pen = Math.abs(w.lat) - lim;
        c.x -= nx * pen;
        c.z -= nz * pen;
        bounce(nx, nz, 0.88);
      }
      if (w.start) bounce(-p.tx, -p.tz, 0.5);
      if (w.end) bounce(p.tx, p.tz, 0.5);
    }
    // Rocks (and the barrier booms).
    world.queryColliders(c.x, c.z, (o) => {
      if (Math.abs(o.y - c.y) > 5) return;
      const dx = c.x - o.x, dz = c.z - o.z, min = o.r + BOAT_R, d2 = dx * dx + dz * dz;
      if (d2 >= min * min || d2 === 0) return;
      const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
      c.x = o.x + nx * min;
      c.z = o.z + nz * min;
      bounce(-nx, -nz, 0.75);
    });
    if (Math.abs(c.x) > LIMIT || Math.abs(c.z) > LIMIT) {
      c.x = Math.max(-LIMIT, Math.min(LIMIT, c.x));
      c.z = Math.max(-LIMIT, Math.min(LIMIT, c.z));
      c.vx *= -0.3;
      c.vz *= -0.3;
    }

    // Vertical: buoyancy spring on the water, gravity everywhere else.
    if (wet && c.y <= surfaceY) {
      if (c.vy < -5) events.push({ type: 'land', strength: -c.vy });
      c.vy += ((surfaceY - c.y) * 80 - c.vy * 9) * dt;
    } else {
      c.vy -= VERT_G * dt;
    }
    c.y += c.vy * dt;
    const floor = world.terrainHeight(c.x, c.z);
    if (!wet && c.y < floor) {
      c.y = floor;
      c.vy = 0;
    }
  }

  function step(dt, inp) {
    const n = Math.max(1, Math.ceil(dt / SUBSTEP - 1e-6));
    for (let i = 0; i < n; i++) substep(dt / n, inp);
  }

  return { state: c, events, place, step, shift() {} };
}
