// Car physics: a "bicycle model" (front + rear axle) with real tyre slip, weight transfer, friction circles,
// an engine torque curve and a 6-speed gearbox. Runs only on the driver's machine.
import { MAP_HALF } from './shared.js';

const G = 9.81;
const VERT_G = 17; // gravity used for jumps (a bit floatier than real for feel)
const MASS = 1250; // kg
const A = 1.2, B = 1.3, L = A + B; // CG to front / rear axle (m)
const CG_H = 0.5;
const INERTIA = 1700; // yaw inertia (kg m²)
const WHEEL_R = 0.33;
const FINAL = 4.1;
const DRIVE_FRONT = 0.45; // AWD torque split
const BRAKE_FORCE = 16000, BRAKE_FRONT = 0.62;
const MAX_STEER = 0.6; // rad at standstill; reduced with speed
const CAR_R = 1.6;
const LIMIT = MAP_HALF - 20;
const SUBSTEP = 1 / 240;

export const GEAR_NAMES = ['R', 'N', '1', '2', '3', '4', '5', '6'];
const RATIOS = [-3.3, 0, 3.3, 2.3, 1.75, 1.4, 1.15, 0.95];
export const IDLE = 900, REDLINE = 7000, LIMITER = 7600;

const TORQUE = [[0, 200], [1000, 250], [2500, 370], [4500, 450], [6000, 420], [7000, 370], [7600, 300]];
function torqueAt(rpm) {
  for (let i = 1; i < TORQUE.length; i++) {
    if (rpm <= TORQUE[i][0]) {
      const [r0, t0] = TORQUE[i - 1], [r1, t1] = TORQUE[i];
      return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
    }
  }
  return TORQUE[TORQUE.length - 1][1];
}

// Simplified Pacejka: lateral force opposing slip angle.
const tyre = (slip, load, mu, stiff) => -mu * load * Math.sin(1.5 * Math.atan(stiff * slip));

export function createSim(world) {
  const surfaceMu = world.map.mu ?? 1.0;
  const surfaceStiff = world.map.stiffness ?? 10;
  const c = {
    x: 0, y: 0, z: 0, h: 0, vx: 0, vz: 0, vy: 0, wr: 0, fwd: 0, steer: 0, pitch: 0, roll: 0,
    grounded: true, airTime: 0, onRoad: true, throttle: 0, lastGround: 0, groundVy: 0,
    gear: 2, rpm: IDLE, shiftTimer: 0, auto: false, ax: 0, ay: 0, wheelspin: 0, locked: false, pedal: 0,
  };
  const events = [];
  const ground = (x, z) => world.surface(x, z).h;

  function place(x, z, h) {
    const y = ground(x, z);
    Object.assign(c, {
      x, z, h, y, vx: 0, vz: 0, vy: 0, wr: 0, fwd: 0, steer: 0, pitch: 0, roll: 0, grounded: true, airTime: 0,
      lastGround: y, groundVy: 0, gear: 2, rpm: IDLE, shiftTimer: 0, ax: 0, ay: 0, pedal: 0,
    });
  }

  function shift(dir) {
    const next = c.gear + dir;
    if (next < 0 || next >= RATIOS.length) return;
    const u = c.vx * Math.sin(c.h) + c.vz * Math.cos(c.h);
    if (next === 0 && u > 2) return; // can't select reverse while rolling forward
    c.gear = next;
    c.shiftTimer = 0.15;
  }

  function collide() {
    world.queryColliders(c.x, c.z, (o) => {
      if (Math.abs(o.y - c.y) > 5) return;
      const dx = c.x - o.x, dz = c.z - o.z, min = o.r + (o.rail ? 1.0 : CAR_R), d2 = dx * dx + dz * dz;
      if (d2 >= min * min || d2 === 0) return;
      const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
      c.x = o.x + nx * min;
      c.z = o.z + nz * min;
      const vn = c.vx * nx + c.vz * nz;
      if (vn < 0) {
        if (vn < -6) events.push({ type: 'hit', strength: -vn });
        c.vx = (c.vx - 1.4 * vn * nx) * 0.8;
        c.vz = (c.vz - 1.4 * vn * nz) * 0.8;
        c.wr *= 0.5;
      }
    });
    if (Math.abs(c.x) > LIMIT || Math.abs(c.z) > LIMIT) {
      c.x = Math.max(-LIMIT, Math.min(LIMIT, c.x));
      c.z = Math.max(-LIMIT, Math.min(LIMIT, c.z));
      c.vx *= -0.3;
      c.vz *= -0.3;
    }
  }

  function substep(dt, inp) {
    const fx = Math.sin(c.h), fz = Math.cos(c.h);
    const rx = -fz, rz = fx; // car's right
    let u = c.vx * fx + c.vz * fz; // forward speed
    let v = c.vx * rx + c.vz * rz; // sideways speed (right +)
    const surf = world.surface(c.x, c.z);
    c.onRoad = !!surf.road;
    c.grounded = c.y - surf.h < 0.12;
    c.shiftTimer = Math.max(0, c.shiftTimer - dt);

    // Keys are all-or-nothing, so the throttle pedal travels in over ~0.2 s (released instantly).
    c.pedal = inp.throttle > c.pedal ? Math.min(inp.throttle, c.pedal + dt * 5) : inp.throttle;
    let throttle = c.pedal, brake = inp.brake;
    const ratioNow = RATIOS[c.gear] * FINAL;
    const wheelRpm = (u / WHEEL_R) * (60 / (2 * Math.PI));

    // Automatic gearbox (optional). In reverse, the brake pedal drives and throttle brakes.
    if (c.auto) {
      if (c.gear >= 2 && u < 0.5 && brake > 0 && throttle === 0) c.gear = 0;
      if (c.gear === 0 && (throttle > 0 || u > 1)) c.gear = 2;
      if (c.gear === 0) [throttle, brake] = [brake, throttle];
      if (c.gear === 1) c.gear = 2;
      if (c.grounded && !c.shiftTimer && c.gear >= 2) {
        const roadRpm = Math.abs(wheelRpm * ratioNow);
        if (roadRpm > REDLINE - 150 && c.gear < 7) shift(1);
        else if (c.gear > 2 && roadRpm < 2800) shift(-1);
      }
    }
    c.throttle = throttle;

    // Engine speed: locked to the wheels in gear, with clutch slip for launches; free-revving otherwise.
    const ratio = RATIOS[c.gear] * FINAL;
    const free = ratio === 0 || !c.grounded;
    if (c.shiftTimer > 0 && !free) {
      c.rpm += (Math.max(IDLE, Math.abs(wheelRpm * ratio)) - c.rpm) * Math.min(1, dt * 14); // rev-match the new gear
    } else if (free) {
      const target = IDLE + throttle * (LIMITER - IDLE);
      c.rpm += (target - c.rpm) * Math.min(1, dt * (throttle ? 8 : 3));
    } else {
      const locked = Math.abs(wheelRpm * ratio);
      const launch = IDLE + throttle * 2600; // clutch slips until the wheels catch up
      c.rpm = Math.max(locked, launch * Math.max(0, 1 - locked / 3500), IDLE);
    }
    c.rpm = Math.min(c.rpm, LIMITER + 50);
    const cut = c.rpm >= LIMITER;

    if (c.grounded) {
      c.airTime = 0;
      const mu = c.onRoad ? surfaceMu : 0.62;
      const stiff = c.onRoad ? surfaceStiff : 6;
      const sgn = Math.sign(u);

      // Weight transfer
      const fzF = Math.max(0.15 * MASS * G, (MASS * G * B) / L - (MASS * c.ax * CG_H) / L);
      const fzR = Math.max(0.15 * MASS * G, (MASS * G * A) / L + (MASS * c.ax * CG_H) / L);

      // Longitudinal: engine (+ engine braking), brakes, handbrake. Each axle limited by its grip.
      let drive = 0;
      if (ratio !== 0 && c.shiftTimer === 0) {
        if (throttle > 0 && !cut) drive = (torqueAt(c.rpm) * throttle * ratio) / WHEEL_R;
        else if (throttle === 0) drive = (-Math.sign(u) * c.rpm * 0.009 * Math.abs(ratio)) / WHEEL_R;
      }
      const brakeF = Math.abs(u) > 0.3 ? brake * BRAKE_FORCE : 0;
      let fxF = drive * DRIVE_FRONT - sgn * brakeF * BRAKE_FRONT;
      let fxR = drive * (1 - DRIVE_FRONT) - sgn * brakeF * (1 - BRAKE_FRONT);
      if (inp.hand && Math.abs(u) > 0.3) fxR = -sgn * mu * fzR * 0.8;
      const capF = mu * fzF, capR = mu * fzR;
      c.wheelspin = Math.max(0, (Math.abs(fxR) - capR) / capR, (Math.abs(fxF) - capF) / capF);
      const lockF = brakeF * BRAKE_FRONT > capF * 1.05, lockR = inp.hand || brakeF * (1 - BRAKE_FRONT) > capR * 1.05;
      c.locked = lockF;
      fxF = Math.max(-capF, Math.min(capF, fxF));
      fxR = Math.max(-capR, Math.min(capR, fxR));

      // Lateral: slip angles → tyre forces, inside each axle's friction circle.
      c.steer += (inp.steer - c.steer) * Math.min(1, dt * (Math.abs(inp.steer) > Math.abs(c.steer) ? 9 : 14));
      const delta = (c.steer * MAX_STEER) / (1 + Math.abs(u) * 0.045);
      const uA = Math.max(Math.abs(u), 2.5);
      const slipF = Math.atan2(v + c.wr * A, uA) - delta * (u >= 0 ? 1 : -1);
      const slipR = Math.atan2(v - c.wr * B, uA);
      let fyF = tyre(slipF, fzF, mu, stiff), fyR = tyre(slipR, fzR, mu * 1.08, stiff); // slight rear bias = stable
      // Friction circle, softened: a spinning or braking tyre keeps about two-thirds of its sideways grip.
      const circF = Math.sqrt(Math.max(0, capF * capF - (0.75 * fxF) ** 2)), circR = Math.sqrt(Math.max(0, capR * capR - (0.75 * fxR) ** 2));
      fyF = Math.max(-circF, Math.min(circF, fyF)) * (lockF ? 0.35 : 1);
      fyR = Math.max(-circR, Math.min(circR, fyR)) * (lockR ? 0.35 : 1);

      // Resistances + gravity along the slope
      const hF = ground(c.x + fx * 1.25, c.z + fz * 1.25), hB = ground(c.x - fx * 1.25, c.z - fz * 1.25);
      const slope = (hF - hB) / L;
      const resist = 0.45 * u * Math.abs(u) + (c.onRoad ? 180 : 900) * Math.sign(u);

      const cd = Math.cos(delta), sd = Math.sin(delta);
      const fxTot = fxF * cd - fyF * sd + fxR - resist - MASS * G * slope;
      const fyTot = fxF * sd + fyF * cd + fyR;
      const yawTorque = A * (fxF * sd + fyF * cd) - B * fyR;

      u += (fxTot / MASS) * dt;
      v += (fyTot / MASS) * dt;
      c.wr += (yawTorque / INERTIA) * dt;
      c.ax += (fxTot / MASS - c.ax) * Math.min(1, dt * 8);
      c.ay += (fyTot / MASS - c.ay) * Math.min(1, dt * 8);

      // At walking pace tyre models misbehave: blend toward simple rolling-car kinematics.
      const slow = Math.max(0, 1 - Math.abs(u) / 4);
      if (slow > 0) {
        c.wr += ((u * Math.tan(delta)) / L - c.wr) * slow * Math.min(1, dt * 12);
        v *= 1 - slow * Math.min(1, dt * 10);
      }
      if (brake > 0 && Math.abs(u) <= 0.3 && throttle === 0) u = 0; // hold still

      // Body: follows the ground, nose dives under braking, leans in corners.
      const hL = ground(c.x - rx * 0.85, c.z - rz * 0.85), hR = ground(c.x + rx * 0.85, c.z + rz * 0.85);
      const k = Math.min(1, 10 * dt);
      c.pitch += (-Math.atan2(hF - hB, L) - c.ax * 0.006 - c.pitch) * k;
      c.roll += (Math.atan2(hL - hR, 1.7) - c.ay * 0.008 - c.roll) * k;
    } else {
      // Airborne: no tyre forces at all. Only air drag; the car keeps whatever spin it had.
      c.airTime += dt;
      u -= ((0.45 * u * Math.abs(u)) / MASS) * dt;
      c.wr *= 1 - 0.3 * dt;
      c.pitch += (Math.max(-0.5, Math.min(0.5, -c.vy * 0.03)) - c.pitch) * Math.min(1, 1.5 * dt);
      c.roll *= 1 - Math.min(1, 1.5 * dt);
      c.wheelspin = 0;
    }

    // Back to world space (old heading), then turn.
    c.vx = fx * u + rx * v;
    c.vz = fz * u + rz * v;
    c.fwd = u;
    c.h -= c.wr * dt;

    const px = c.x, pz = c.z;
    c.x += c.vx * dt;
    c.z += c.vz * dt;
    if (ground(c.x, c.z) - c.y > 1.2) {
      const sp = Math.hypot(c.vx, c.vz);
      if (sp > 6) events.push({ type: 'hit', strength: sp });
      c.x = px;
      c.z = pz;
      c.vx *= -0.3;
      c.vz *= -0.3;
      c.wr *= 0.3;
    }
    collide();

    // Vertical. The ground's vertical speed is low-passed so tiny surface steps don't launch the car.
    const g = ground(c.x, c.z);
    c.groundVy += (Math.min(14, (g - c.lastGround) / dt) - c.groundVy) * Math.min(1, 10 * dt);
    c.vy -= VERT_G * dt;
    c.y += c.vy * dt;
    if (c.y <= g) {
      if (!c.grounded && c.vy < -7) events.push({ type: 'land', strength: -c.vy });
      c.y = g;
      c.vy = Math.max(c.vy, c.groundVy);
    }
    c.lastGround = g;
  }

  function step(dt, inp) {
    const n = Math.max(1, Math.ceil(dt / SUBSTEP - 1e-6));
    for (let i = 0; i < n; i++) substep(dt / n, inp);
  }

  return { state: c, events, place, step, shift };
}
