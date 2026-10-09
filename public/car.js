import * as THREE from 'three';
import { GEAR_NAMES } from './physics.js';

// Car-local axes: +z forward, +y up, +x is the car's LEFT (driver side, left-hand drive).
// Seat origins sit on the floor under each seat; characters are built relative to them.
export const SEATS = {
  driver: new THREE.Vector3(0.4, 0, -0.32),
  passenger: new THREE.Vector3(-0.4, 0, -0.32),
};
export const EYE = new THREE.Vector3(0, 1.37, 0.05); // eye position relative to a seat origin

const flat = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });

// Round gauge face. Values sweep clockwise from -2.2 rad (min) to +2.2 rad (max).
function gaugeTexture({ max, step, major, label, red = Infinity, scale = 1 }) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#16181c';
  g.beginPath();
  g.arc(128, 128, 126, 0, Math.PI * 2);
  g.fill();
  if (red < max) {
    g.strokeStyle = '#d0312d';
    g.lineWidth = 12;
    g.beginPath();
    g.arc(128, 128, 110, -Math.PI / 2 - 2.2 + (red / max) * 4.4, -Math.PI / 2 + 2.2);
    g.stroke();
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 24px system-ui, sans-serif';
  for (let v = 0; v <= max; v += step) {
    const a = -2.2 + (v / max) * 4.4;
    const isMajor = v % major === 0;
    const r0 = isMajor ? 92 : 102;
    g.strokeStyle = g.fillStyle = v >= red ? '#ff6a5a' : '#e8e4da';
    g.lineWidth = isMajor ? 5 : 3;
    g.beginPath();
    g.moveTo(128 + Math.sin(a) * r0, 128 - Math.cos(a) * r0);
    g.lineTo(128 + Math.sin(a) * 116, 128 - Math.cos(a) * 116);
    g.stroke();
    if (isMajor) g.fillText(String(v / scale), 128 + Math.sin(a) * 70, 128 - Math.cos(a) * 70);
  }
  g.fillStyle = '#e8e4da';
  g.font = '18px system-ui, sans-serif';
  g.fillText(label, 128, 186);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Steering wheel + speedometer in front of the driver's seat. Shared by the car and the boat.
// `spin` turns with steering, grips are the driver's hand targets.
export function addCockpit(group, dark, trim) {
  const steerBase = new THREE.Group();
  steerBase.position.set(SEATS.driver.x, 0.97, 0.2);
  steerBase.rotation.x = 0.4;
  group.add(steerBase);
  const steerSpin = new THREE.Group();
  steerBase.add(steerSpin);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.022, 5, 14), dark);
  steerSpin.add(rim);
  for (const a of [Math.PI / 2, Math.PI * 1.15, -Math.PI * 0.15]) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.02), trim);
    spoke.position.set(Math.cos(a) * 0.08, -Math.sin(a) * 0.08, 0);
    spoke.rotation.z = -a + Math.PI / 2;
    steerSpin.add(spoke);
  }
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 6), dark);
  column.rotation.x = Math.PI / 2;
  column.position.z = 0.15;
  steerBase.add(column);
  const grips = [new THREE.Object3D(), new THREE.Object3D()];
  grips[0].position.set(0.17, 0, 0); // driver's left hand (+x)
  grips[1].position.set(-0.17, 0, 0);
  steerSpin.add(...grips);

  // Center gauge cluster on top of the dash, angled slightly toward the driver (unlit so it reads at night).
  const cluster = new THREE.Group();
  cluster.position.set(0.02, 1.08, 0.5); // dash center, clear of the steering wheel
  cluster.rotation.set(-0.35, Math.PI - 0.12, 0, 'YXZ');
  group.add(cluster);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.18, 0.05), dark);
  housing.position.z = -0.03;
  cluster.add(housing);
  const needleGeo = new THREE.BoxGeometry(0.005, 0.06, 0.002);
  needleGeo.translate(0, 0.028, 0.003);
  const needleMat = new THREE.MeshBasicMaterial({ color: 0xff5a36 });
  const gauge = (x, tex) => {
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.075, 24), new THREE.MeshBasicMaterial({ map: tex }));
    face.position.x = x;
    const needle = new THREE.Mesh(needleGeo, needleMat);
    needle.position.x = x;
    cluster.add(face, needle);
    return needle;
  };
  // The cluster faces backwards, so its local +x is on the passenger side: tach goes at -x (driver side).
  const tachNeedle = gauge(-0.13, gaugeTexture({ max: 8000, step: 500, major: 1000, scale: 1000, label: 'RPM x1000', red: 7000 }));
  const speedNeedle = gauge(0.13, gaugeTexture({ max: 240, step: 10, major: 40, label: 'km/h' }));
  // Gear readout + shift light between the dials
  const gearCanvas = document.createElement('canvas');
  gearCanvas.width = 96;
  gearCanvas.height = 128;
  const gearCtx = gearCanvas.getContext('2d');
  const gearTex = new THREE.CanvasTexture(gearCanvas);
  gearTex.colorSpace = THREE.SRGBColorSpace;
  const gearFace = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.08), new THREE.MeshBasicMaterial({ map: gearTex }));
  cluster.add(gearFace);
  let gearShown = '';
  const drawGear = (name, shiftLight) => {
    const key = name + shiftLight;
    if (key === gearShown) return;
    gearShown = key;
    gearCtx.fillStyle = '#0d0e10';
    gearCtx.fillRect(0, 0, 96, 128);
    gearCtx.fillStyle = shiftLight ? '#ff3b2f' : '#2a2c30';
    gearCtx.beginPath();
    gearCtx.arc(48, 20, 12, 0, Math.PI * 2);
    gearCtx.fill();
    gearCtx.fillStyle = name === 'R' ? '#ff9a3c' : '#9dffb0';
    gearCtx.font = 'bold 80px system-ui, sans-serif';
    gearCtx.textAlign = 'center';
    gearCtx.textBaseline = 'middle';
    gearCtx.fillText(name, 48, 82);
    gearTex.needsUpdate = true;
  };
  drawGear('1', false);

  return { steerBase, steerSpin, grips, speedNeedle, tachNeedle, drawGear };
}

export function createCarRig(paint = 0xd9502e) {
  const group = new THREE.Group();
  const body = new THREE.Group(); // procedural shell (hidden if a custom model loads)
  group.add(body);

  const P = flat(paint);
  const dark = flat(0x23252a);
  const trim = flat(0x34373e);
  const seatM = flat(0x4a3f36);
  const glass = new THREE.MeshLambertMaterial({ color: 0xbfe0f0, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false });
  const box = (w, h, d, m, x, y, z, rx = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.rotation.x = rx;
    mesh.castShadow = mesh.receiveShadow = true;
    body.add(mesh);
    return mesh;
  };
  const pane = (w, h, x, y, z, rx, ry = 0) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glass);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, 0, 'YXZ');
    mesh.renderOrder = 2;
    body.add(mesh);
  };

  // Shell (built from separate panels so the cabin is open from the inside)
  box(1.8, 0.58, 1.4, P, 0, 0.67, 1.45); // engine bay + hood
  box(1.8, 0.6, 0.85, P, 0, 0.68, -1.725); // trunk
  box(0.06, 0.62, 2.05, P, 0.87, 0.69, -0.275); // left door
  box(0.06, 0.62, 2.05, P, -0.87, 0.69, -0.275); // right door
  box(1.74, 0.06, 2.05, dark, 0, 0.4, -0.275); // floor
  box(1.74, 0.06, 1.45, P, 0, 1.6, -0.575); // roof
  box(1.86, 0.25, 0.2, dark, 0, 0.5, 2.2); // front bumper
  box(1.86, 0.25, 0.2, dark, 0, 0.5, -2.2); // rear bumper
  box(1.0, 0.18, 0.04, dark, 0, 0.75, 2.16); // grille

  const WS_TILT = -Math.atan2(0.6, 0.57); // windshield leans back
  pane(1.7, 0.83, 0, 1.285, 0.45, WS_TILT);
  for (const x of [0.85, -0.85]) box(0.06, 0.85, 0.06, P, x, 1.285, 0.45, WS_TILT); // A-pillars
  for (const x of [0.86, -0.86]) box(0.07, 0.62, 0.1, P, x, 1.29, -0.78); // B-pillars
  const RW_TILT = Math.atan2(0.55, 0.6);
  pane(1.7, 0.81, 0, 1.3, -1.575, RW_TILT);
  for (const x of [0.85, -0.85]) box(0.07, 0.83, 0.07, P, x, 1.3, -1.575, RW_TILT); // C-pillars
  for (const x of [0.87, -0.87]) pane(1.85, 0.58, x, 1.28, -0.33, 0, Math.PI / 2); // side windows

  // Interior
  box(1.74, 0.2, 0.42, trim, 0, 0.9, 0.54); // dashboard
  box(0.22, 0.3, 0.7, trim, 0, 0.55, 0.15); // center console
  box(0.2, 0.055, 0.02, trim, 0, 1.5, 0.2); // rear-view mirror
  box(0.18, 0.04, 0.005, flat(0x9fb4c4), 0, 1.5, 0.188);
  for (const seat of [SEATS.driver, SEATS.passenger]) {
    box(0.5, 0.12, 0.52, seatM, seat.x, 0.56, seat.z);
    box(0.5, 0.66, 0.12, seatM, seat.x, 0.93, seat.z - 0.32, -0.18);
    box(0.28, 0.2, 0.1, seatM, seat.x, 1.36, seat.z - 0.4);
  }
  box(1.5, 0.12, 0.45, seatM, 0, 0.56, -1.05); // rear bench
  box(1.5, 0.6, 0.12, seatM, 0, 0.9, -1.3, -0.15);

  // Lights
  const head = flat(0xfff3c4, { emissive: 0xffe9a0, emissiveIntensity: 0.6 });
  const tail = flat(0xff3a2a, { emissive: 0xaa1100, emissiveIntensity: 0.5 });
  for (const x of [0.6, -0.6]) {
    box(0.4, 0.18, 0.05, head, x, 0.85, 2.16);
    box(0.4, 0.16, 0.05, tail, x, 0.85, -2.16);
  }
  const headlights = [];
  for (const x of [0.6, -0.6]) {
    const spot = new THREE.SpotLight(0xfff1d0, 60, 140, 0.5, 0.55, 1);
    spot.position.set(x, 0.85, 2.2);
    spot.target.position.set(x * 2, 0, 30);
    spot.visible = false;
    group.add(spot, spot.target);
    headlights.push(spot);
  }
  const cabinLight = new THREE.PointLight(0xffd9a0, 0.25, 1.6, 1); // faint dash glow
  cabinLight.position.set(0, 1.0, 0.2);
  cabinLight.visible = false;
  group.add(cabinLight);

  // Wheels (pivot steers, inner mesh spins)
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 8);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = flat(0x1c1c1f);
  const wheels = {};
  for (const [key, x, z] of [['fl', 0.93, 1.35], ['fr', -0.93, 1.35], ['rl', 0.93, -1.35], ['rr', -0.93, -1.35]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.36, z);
    const spin = new THREE.Mesh(wheelGeo, wheelMat);
    spin.castShadow = true;
    pivot.add(spin);
    group.add(pivot);
    wheels[key] = { pivot, spin };
  }

  const { steerBase, steerSpin, grips, speedNeedle, tachNeedle, drawGear } = addCockpit(group, dark, trim);

  const rig = {
    group,
    body,
    wheels,
    steering: steerSpin,
    steerBase,
    grips,
    seats: { driver: SEATS.driver.clone(), passenger: SEATS.passenger.clone() },
    custom: null,
    setNight(on) {
      for (const s of headlights) s.visible = on;
      cabinLight.visible = on;
    },
    update(dt, speed, steer, rpm = 900, gear = 2) {
      const w = rig.custom?.wheels || wheels;
      for (const key of ['fl', 'fr', 'rl', 'rr']) {
        const wheel = w[key];
        if (!wheel) continue;
        wheel.spin.rotation.x += (speed / 0.36) * dt;
        if (key[0] === 'f') wheel.pivot.rotation.y = -steer * 0.5;
      }
      steerSpin.rotation.z = steer * 2.4;
      if (rig.custom?.steering) rig.custom.steering.rotation.z = rig.custom.steeringBaseZ + steer * 2.4;
      speedNeedle.rotation.z = 2.2 - (Math.min(240, Math.abs(speed) * 3.6) / 240) * 4.4;
      tachNeedle.rotation.z = 2.2 - (Math.min(8000, rpm) / 8000) * 4.4;
      drawGear(GEAR_NAMES[gear] ?? '?', rpm > 6800);
    },
  };
  return rig;
}

// Optional: drop a Blender export at public/models/car.glb (or boat.glb) and it replaces the built-in shell.
// See README.md for the node names it looks for (wheels, steering wheel, seat eye positions).
export async function tryLoadCustomCar(rig, url = 'models/car.glb') {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) return false;
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(url);
    const model = gltf.scene;
    model.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = true;
    });
    rig.body.visible = false;
    rig.group.add(model);
    model.updateMatrixWorld(true);
    const find = (name) => model.getObjectByName(name);
    const custom = { wheels: {}, steering: null, steeringBaseZ: 0 };

    for (const [key, name] of [['fl', 'Wheel_FL'], ['fr', 'Wheel_FR'], ['rl', 'Wheel_RL'], ['rr', 'Wheel_RR']]) {
      const node = find(name);
      if (!node) continue;
      node.rotation.order = 'YXZ';
      custom.wheels[key] = { pivot: node, spin: node };
      if (rig.wheels[key]) rig.wheels[key].pivot.visible = false;
    }
    const sw = find('SteeringWheel');
    if (sw) {
      custom.steering = sw;
      custom.steeringBaseZ = sw.rotation.z;
      rig.steerBase.visible = false;
      // Re-home the hand targets onto the custom wheel.
      const r = 0.17;
      rig.grips[0].position.set(r, 0, 0);
      rig.grips[1].position.set(-r, 0, 0);
      sw.add(...rig.grips);
    }
    const toLocal = (node) => rig.group.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
    for (const [role, name] of [['driver', 'Seat_Driver'], ['passenger', 'Seat_Passenger']]) {
      const node = find(name);
      if (node) rig.seats[role] = toLocal(node).sub(EYE); // node marks the eye position
    }
    rig.custom = custom;
    console.log(`[vehicle] loaded ${url}`, Object.keys(custom.wheels), sw ? '+ steering wheel' : '');
    return true;
  } catch (err) {
    console.warn(`[vehicle] could not load ${url}, using the built-in model`, err);
    return false;
  }
}
