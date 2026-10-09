import * as THREE from 'three';
import { SEATS, addCockpit } from './car.js';

// Built-in jet boat: an open runabout with two front seats, a windshield and the same helm/gauges as the car.
// Same rig interface as createCarRig. Boat-local axes match the car: +z forward (bow), +y up, +x is LEFT (port).
// The group origin sits on the waterline. Drop public/models/boat.glb in to replace the shell (see README).

const flat = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });

// Hull plan view, [x, z]: square stern, straight sides, pointed bow.
const OUTLINE = [[1.1, -2.6], [1.15, 0.8], [0.78, 2.5], [0, 3.55], [-0.78, 2.5], [-1.15, 0.8], [-1.1, -2.6]];
const COCKPIT = [[1.03, -2.5], [1.06, 0.75], [-1.06, 0.75], [-1.03, -2.5]];

function shapeOf(pts, scale = 1) {
  const s = new THREE.Shape();
  pts.forEach(([x, z], i) => (i ? s.lineTo(x * scale, -z * scale) : s.moveTo(x * scale, -z * scale)));
  s.closePath();
  return s;
}

// Wake: two white streaks spreading back from the stern, drawn once.
function wakeTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d');
  for (let y = 0; y < 256; y++) {
    const k = y / 256, spread = 10 + k * 50, a = (1 - k) * 0.9;
    for (const sgn of [-1, 1]) {
      g.fillStyle = `rgba(255,255,255,${a * (0.6 + Math.random() * 0.4)})`;
      g.fillRect(64 + sgn * spread - 5 - k * 6, y, 10 + k * 12, 1);
    }
    g.fillStyle = `rgba(235,245,250,${a * 0.35})`;
    g.fillRect(64 - spread + 6, y, spread * 2 - 12, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createBoatRig(paint = 0xf2efe8, stripe = 0x1f6fd1) {
  const group = new THREE.Group();
  const body = new THREE.Group(); // procedural shell (hidden if a custom model loads)
  group.add(body);

  const hullM = flat(paint);
  const stripeM = flat(stripe);
  const deckM = flat(0x9a7350);
  const dark = flat(0x23252a);
  const trim = flat(0x34373e);
  const seatM = flat(0xd9d0bc);
  const glass = new THREE.MeshLambertMaterial({ color: 0xbfe0f0, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthWrite: false });

  const slab = (shape, y0, y1, m) => {
    const geo = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // shape (x, -z) → plan view, extrusion → up
    geo.translate(0, y0, 0);
    const mesh = new THREE.Mesh(geo, m);
    mesh.castShadow = mesh.receiveShadow = true;
    body.add(mesh);
    return mesh;
  };
  const box = (w, h, d, m, x, y, z, rx = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.rotation.x = rx;
    mesh.castShadow = mesh.receiveShadow = true;
    body.add(mesh);
    return mesh;
  };

  // Hull: solid below the cockpit floor, open-topped walls above it, covered foredeck.
  slab(shapeOf(OUTLINE), -0.35, 0.35, hullM);
  const walls = shapeOf(OUTLINE);
  walls.holes.push(shapeOf(COCKPIT));
  slab(walls, 0.35, 0.95, hullM);
  slab(shapeOf(OUTLINE, 1.012), 0.5, 0.62, stripeM); // hull stripe
  const rail = shapeOf(OUTLINE, 1.01);
  rail.holes.push(shapeOf(COCKPIT, 0.99));
  slab(rail, 0.95, 0.99, deckM); // wooden gunwale cap
  box(2.04, 0.02, 3.2, deckM, 0, 0.36, -0.88); // teak cockpit floor

  // Windshield
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 0.46), glass);
  ws.position.set(0, 1.17, 0.82);
  ws.rotation.x = -0.55;
  ws.renderOrder = 2;
  body.add(ws);
  box(2.12, 0.04, 0.04, trim, 0, 1.37, 0.71, -0.55); // windshield top frame

  // Interior
  box(1.9, 0.26, 0.36, trim, 0, 0.84, 0.56); // dashboard
  for (const seat of [SEATS.driver, SEATS.passenger]) {
    box(0.5, 0.2, 0.52, seatM, seat.x, 0.5, seat.z);
    box(0.5, 0.62, 0.12, seatM, seat.x, 0.92, seat.z - 0.32, -0.18);
  }
  box(1.9, 0.2, 0.5, seatM, 0, 0.5, -1.7); // rear bench
  box(1.9, 0.45, 0.12, seatM, 0, 0.82, -2.0, -0.12);
  box(0.9, 0.55, 0.55, dark, 0, 0.75, -2.42); // engine cover
  box(0.5, 0.2, 0.4, dark, 0, -0.2, -2.75); // jet nozzle
  box(0.04, 0.9, 0.04, trim, 0, 1.4, -2.4); // stern light pole

  // Lights: running lights (red port, green starboard), stern white, and two forward spotlights for night.
  const glow = (color) => flat(color, { emissive: color, emissiveIntensity: 0.8 });
  box(0.08, 0.06, 0.14, glow(0xff3020), 1.0, 1.0, 1.1);
  box(0.08, 0.06, 0.14, glow(0x30ff60), -1.0, 1.0, 1.1);
  box(0.08, 0.08, 0.08, glow(0xffffff), 0, 1.88, -2.4);
  const head = flat(0xfff3c4, { emissive: 0xffe9a0, emissiveIntensity: 0.6 });
  const headlights = [];
  for (const x of [0.35, -0.35]) {
    box(0.22, 0.12, 0.08, head, x, 1.0, 2.75);
    const spot = new THREE.SpotLight(0xfff1d0, 70, 160, 0.45, 0.5, 1);
    spot.position.set(x, 1.05, 2.8);
    spot.target.position.set(x * 2, -0.5, 32);
    spot.visible = false;
    group.add(spot, spot.target);
    headlights.push(spot);
  }
  const cabinLight = new THREE.PointLight(0xffd9a0, 0.25, 1.6, 1);
  cabinLight.position.set(0, 1.0, 0.2);
  cabinLight.visible = false;
  group.add(cabinLight);

  // Wake behind the stern, fades in with speed.
  const wakeTex = wakeTexture();
  const wakeMat = new THREE.MeshBasicMaterial({ map: wakeTex, transparent: true, opacity: 0, depthWrite: false });
  const wake = new THREE.Mesh(new THREE.PlaneGeometry(14, 22), wakeMat);
  wake.rotation.x = -Math.PI / 2;
  wake.rotation.z = Math.PI; // texture top (narrow end) at the stern
  wake.position.set(0, 0.04, -2.6 - 11);
  wake.renderOrder = 1;
  group.add(wake);

  const { steerBase, steerSpin, grips, speedNeedle, tachNeedle, drawGear } = addCockpit(group, dark, trim);

  const rig = {
    group,
    body,
    wheels: {},
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
      steerSpin.rotation.z = steer * 2.4;
      if (rig.custom?.steering) rig.custom.steering.rotation.z = rig.custom.steeringBaseZ + steer * 2.4;
      speedNeedle.rotation.z = 2.2 - (Math.min(240, Math.abs(speed) * 3.6) / 240) * 4.4;
      tachNeedle.rotation.z = 2.2 - (Math.min(8000, rpm) / 8000) * 4.4;
      drawGear(gear === 0 ? 'R' : 'F', rpm > 6800);
      wakeMat.opacity += (Math.min(0.85, Math.max(0, speed - 2) / 14) - wakeMat.opacity) * Math.min(1, dt * 3);    },
  };
  return rig;
}
