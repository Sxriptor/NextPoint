import * as THREE from 'three';
import { MAPS, VISIBILITY } from './maps.js';
import { RESET_PENALTY, ROAD_HALF, lerp, angleDiff } from './shared.js';
import { generateWorld } from './terrain.js';
import { buildWorldMeshes, disposeTree, checkpointIndices } from './world.js';
import { createCarRig, tryLoadCustomCar, EYE } from './car.js';
import { createBoatRig } from './boat.js';
import { createCharacter } from './character.js';
import { createMapView } from './mapview.js';
import { createSim, IDLE } from './physics.js';
import { createBoatSim } from './boatphysics.js';
import { connectNet } from './net.js';
import { Voice } from './voice.js';
import { createEngine, chime, thud, setListener } from './audio.js';

const $ = (id) => document.getElementById(id);
const ROLE_NAME = { driver: 'Driver', passenger: 'Navigator' };
const OTHER = { driver: 'passenger', passenger: 'driver' };
const SEND_HZ = { driver: 60, passenger: 20 };
const INTERP_DELAY_MS = 45; // navigator renders the car this far behind the driver (smooths network jitter)
const NO_INPUT = { throttle: 0, brake: 0, steer: 0, hand: false };
const params = new URLSearchParams(location.search);

// ---------- Renderer & scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa9c9e8);
scene.fog = new THREE.Fog(0xa9c9e8, 250, 1300);
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 2600);
scene.add(camera);

const hemi = new THREE.HemisphereLight(0xffffff, 0x556644, 1.3);
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 500 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(hemi, sun, sun.target);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- State ----------
let net, voice, audioCtx, engine;
let slot = 0, peer = false, lobby = null, phase = 'start', role = 'driver';
let pendingMap = null;
let world = null, worldGroup = null, worldMapId = null, sim = null;
let wantedMap = null, worldChain = Promise.resolve();
let rig = null, mapMesh = null;
const chars = {};
const mapView = createMapView();
const car = { x: 0, y: 0, z: 0, h: 0, p: 0, r: 0, f: 0, s: 0, th: 0, rpm: IDLE, g: 2 };
const carBuf = []; // driver snapshots, on the navigator's side
const look = { yaw: 0, pitch: -0.08 };
const partner = { yaw: 0, pitch: 0, mapUp: false };
let mapUp = false, mapUpT = 0, mapZoom = 1.7, rmbHeld = false;
const head = { off: 0, vel: 0, lastY: 0, lastVy: 0 }; // camera bounce
let raceStart = 0, finished = false, progress = 0;
let paused = false, pauseAt = 0, wasLocked = false, lastAutoPause = 0;
let checkpoints = [], splits = []; // checkpoint sample indices (3 + finish) and split times (s)
const stats = { wrong: 0, resets: 0, pen: 0 };

// Per-player settings (this browser only)
const settings = { sens: 1, gearbox: 'manual', wheelIndex: 0, wheelAxis: 0, throttleAxis: 1, brakeAxis: 2, invertSteer: false, invertThrottle: true, invertBrake: true };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('twolane.settings') || '{}'));
} catch {}
function saveSettings() {
  try {
    localStorage.setItem('twolane.settings', JSON.stringify(settings));
  } catch {}
}
let countedWrong = new Set();
let sendAcc = 0, mapAcc = 0, last = performance.now();

// ---------- UI helpers ----------
let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}
function setVoiceStatus(state) {
  $('voiceStatus').textContent = {
    connecting: 'Voice: connecting…',
    new: 'Voice: connecting…',
    connected: 'Voice: connected',
    disconnected: 'Voice: reconnecting…',
    failed: 'Voice failed (network blocks peer-to-peer; needs a TURN server)',
  }[state] ?? '';
}
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const show = (id, on) => ($(id).hidden = !on);

$('copyLink').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Invite link copied');
  } catch {
    toast(location.href);
  }
});

// ---------- World / car setup ----------
// Builds are queued so overlapping requests never generate the same stage twice.
function ensureWorld(mapId) {
  wantedMap = mapId;
  worldChain = worldChain
    .catch(() => {})
    .then(() => (worldMapId === wantedMap ? null : buildWorld(wantedMap)))
    .catch((err) => {
      show('loading', false);
      throw err;
    });
  return worldChain;
}

async function buildWorld(mapId) {
  show('loading', true);
  await new Promise((r) => setTimeout(r, 30)); // let the loading screen paint
  if (worldGroup) {
    scene.remove(worldGroup);
    disposeTree(worldGroup);
  }
  world = generateWorld(MAPS[mapId]);
  worldGroup = buildWorldMeshes(world, MAPS[mapId]);
  scene.add(worldGroup);
  worldMapId = mapId;
  mapView.setWorld(world);
  sim = world.vehicle === 'boat' ? createBoatSim(world) : createSim(world);
  applyAtmosphere();
  show('loading', false);
}

function applyAtmosphere() {
  if (!world) return;
  const map = MAPS[worldMapId];
  const vis = phase === 'race' ? lobby?.vis : 'clear';
  const night = vis === 'night', fog = vis === 'fog';
  const sky = night ? 0x060914 : fog ? 0xb8bdc1 : map.sky;
  scene.background.set(sky);
  scene.fog.color.set(sky);
  scene.fog.near = night ? 15 : fog ? 2 : 250;
  scene.fog.far = night ? 230 : fog ? 55 : 1300;
  hemi.color.set(night ? 0x6070a0 : map.hemi[0]);
  hemi.groundColor.set(night ? 0x101018 : map.hemi[1]);
  hemi.intensity = night ? 0.15 : fog ? 1.1 : map.hemi[2];
  sun.color.set(night ? 0x9fb3e0 : map.sun[0]);
  sun.intensity = night ? 0.2 : fog ? 0.6 : map.sun[1];
  worldGroup.userData.clouds.visible = !night && !fog;
  worldGroup.userData.stars.visible = night;
  rig?.setNight(night);
}

let rigPromise = null, rigVehicle = null;
function ensureRig(vehicle) {
  if (rigPromise && rigVehicle === vehicle) return rigPromise;
  if (rig) {
    scene.remove(rig.group);
    disposeTree(rig.group);
    rig = null;
    mapMesh = null;
  }
  rigVehicle = vehicle;
  rigPromise = (async () => {
    const r = vehicle === 'boat' ? createBoatRig() : createCarRig();
    if (vehicle !== 'boat') await tryLoadCustomCar(r);
    const eyeOffset = EYE;
    const seatLift = vehicle === 'boat' ? 0.48 : 0.56;
    const driverShirt = vehicle === 'boat' ? 0xf0a53a : 0xc8402f;
    const passengerShirt = vehicle === 'boat' ? 0x2f8fa8 : 0x2f8fa8;
    chars.driver = createCharacter({ shirt: driverShirt });
    chars.passenger = createCharacter({ shirt: passengerShirt, hair: 0x7a4a22 });
    for (const role of ['driver', 'passenger']) {
      chars[role].group.position.copy(r.seats[role]);
      r.group.add(chars[role].group);
    }
    const paper = new THREE.Group();
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.315), new THREE.MeshBasicMaterial({ map: mapView.texture }));
    const back = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.315), new THREE.MeshLambertMaterial({ color: 0xe6d9bb }));
    back.rotation.y = Math.PI;
    paper.add(face, back);
    paper.userData.handles = [new THREE.Vector3(0.2, -0.13, 0.01), new THREE.Vector3(-0.2, -0.13, 0.01)];
    r.group.add(paper);
    mapMesh = paper;
    // Keep cabin-specific offsets on the rig so camera and character poses share one setup path.
    r.eyeOffset = eyeOffset;
    r.seatLift = seatLift;
    scene.add(r.group);
    rig = r;
  })();
  return rigPromise;
}
function placeCarAt(index) {
  const s = world.main.s[index];
  const h = Math.atan2(s.tx, s.tz);
  sim.place(s.x, s.z, h);
  Object.assign(car, { x: s.x, y: sim.state.y, z: s.z, h, p: 0, r: 0, f: 0, s: 0, th: 0 });
  head.lastY = car.y;
  head.lastVy = 0;
}

// ---------- Lobby ----------
function renderLobby() {
  if (!lobby) return;
  $('roomName').textContent = roomInput.value;
  const seatEl = $('seatChoices');
  seatEl.innerHTML = '';
  for (const r of ['driver', 'passenger']) {
    const mine = lobby.roles[slot] === r;
    const b = document.createElement('button');
    b.className = `choice seat${mine ? ' on mine' : ''}`;
    b.innerHTML = `<b>${ROLE_NAME[r]}</b><span class="who">${mine ? 'You' : peer ? 'Your partner' : 'Empty, waiting for partner'}</span>
      <span>${r === 'driver' ? 'Drives. Has no map.' : 'Holds the map and calls the turns.'}</span>`;
    b.onclick = () => net.send({ t: 'set', role: r });
    seatEl.append(b);
  }
  const fill = (el, items, key) => {
    el.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.className = `choice${lobby[key] === it.id ? ' on' : ''}`;
      const tags = it.tags?.length ? `<span class="tags">${it.tags.map((t) => `<i>${t}</i>`).join('')}</span>` : '';
      b.innerHTML = `<b>${it.name}</b>${tags}<span>${it.blurb}</span>`;
      b.onclick = () => {
        if (key === 'map') {
          lobby.map = it.id;
          pendingMap = it.id;
          renderLobby();
          $('lobbyMsg').textContent = `Loading ${it.name}…`;
          ensureWorld(it.id).catch((err) => {
            console.error(`Could not build ${it.name}`, err);
            show('loading', false);
            $('lobbyMsg').textContent = `Could not load ${it.name}. Try selecting it again.`;
          });
        }
        if (!net?.send({ t: 'set', [key]: it.id })) {
          $('lobbyMsg').textContent = 'Connection lost. Rejoin the room to change the stage.';
        }
      };
      el.append(b);
    }
  };
  fill($('mapChoices'), Object.values(MAPS), 'map');
  fill($('visChoices'), VISIBILITY, 'vis');
  $('lobbyMsg').textContent = peer
    ? 'Either player can change settings or start.'
    : 'Your partner isn’t here yet. You can start solo to try things out.';
}

function showLobby() {
  phase = 'lobby';
  document.exitPointerLock?.();
  show('start', false);
  show('results', false);
  show('hud', false);
  show('lobby', true);
  engine?.set(0, 0, false);
  applyAtmosphere();
  renderLobby();
  ensureWorld(lobby.map);
}

function showResults(res) {
  phase = 'results';
  document.exitPointerLock?.();
  show('hud', false);
  show('results', true);
  engine?.set(0, 0, false);
  $('resultsTitle').textContent = `${MAPS[lobby.map].name}: stage complete`;
  $('resultsBody').innerHTML = `
    <span>Drive time</span><b>${fmtTime(res.time - res.pen)}</b>
    <span>Resets / falls (+${RESET_PENALTY} s each)</span><b>${res.resets}</b>
    <span>Wrong turns taken</span><b>${res.wrong}</b>
    ${(res.splits || []).map((t, i) => `<span>${i < 3 ? `Checkpoint ${i + 1}` : 'Finish'} split</span><b>${fmtTime(t)}</b>`).join('')}
    <span class="total">Final time</span><b class="total">${fmtTime(res.time)}</b>`;
  chime(audioCtx, true);
}
$('toLobbyBtn').onclick = () => net.send({ t: 'to-lobby' });
$('startBtn').onclick = () => net.send({ t: 'start' });

// ---------- Race ----------
async function startRace(delayMs) {
  phase = 'race';
  show('lobby', false);
  show('results', false);
  role = lobby.roles[slot];
  await ensureWorld(lobby.map);
  await ensureRig(MAPS[lobby.map].vehicle === 'boat' ? 'boat' : 'car');
  applyAtmosphere();
  finished = false;
  progress = world.startIndex;
  checkpoints = checkpointIndices(world);
  splits = [];
  setPaused(false);
  if (world.vehicle !== 'boat') sim.state.auto = settings.gearbox === 'auto';
  renderProgressBar();
  Object.assign(stats, { wrong: 0, resets: 0, pen: 0 });
  countedWrong = new Set();
  carBuf.length = 0;
  look.yaw = Number(params.get('yaw')) || 0; // ?yaw= is a dev shortcut
  look.pitch = -0.08;
  mapUp = role === 'passenger';
  head.off = head.vel = 0;
  progress = Math.min(world.main.s.length - 10, Number(params.get('at')) || world.startIndex); // ?at= is a dev shortcut
  placeCarAt(progress);
  raceStart = performance.now() + delayMs;

  rig.group.add(camera);
  camera.position.copy(rig.seats[role]).add(rig.eyeOffset || EYE);
  chars[role].setFirstPerson(true);
  chars[OTHER[role]].setFirstPerson(false);
  chars[OTHER[role]].group.visible = peer;
  chars[role].group.visible = true;
  chars.driver.setBlindfold(lobby.vis === 'blindfold');
  if (role === 'passenger') mapView.draw(car, mapZoom, progress);
  else mapView.drawBlank();

  show('hud', true);
  show('blind', role === 'driver' && lobby.vis === 'blindfold');
  $('help').style.opacity = 1;
  $('help').innerHTML =
    role === 'driver'
      ? world.vehicle === 'boat'
        ? '<b>You are the Boat Driver.</b> W/S throttle and reverse · A/D steer · Space loosen the keel to slide · R reset (+5 s) · M mute · Esc pause. Listen to your navigator.'
        : `<b>You are the Driver.</b> W/S throttle and brake · A/D steer · Space handbrake · ${settings.gearbox === 'auto' ? 'automatic gearbox' : 'E/Q shift up/down (Q below 1st = neutral, then reverse)'} · R reset (+5 s) · M mute · Esc pause. You have no map: listen to your navigator.`
      : '<b>You are the Navigator.</b> Space or hold right-click to raise the map · scroll to zoom · M mute · mouse to look · Esc pause. Green is the route, red roads are wrong turns. Tell your driver where to go.';
  $('gearbox').closest('label').hidden = world.vehicle === 'boat';
  setTimeout(() => ($('help').style.opacity = 0.35), 15000);
  $('partnerStatus').textContent = peer ? `${ROLE_NAME[OTHER[role]]}: connected` : `${ROLE_NAME[OTHER[role]]}: nobody (solo)`;
}

function respawn(kind) {
  stats.resets++;
  stats.pen += RESET_PENALTY;
  placeCarAt(Math.max(world.startIndex, progress - 4));
  const text = { reset: 'Reset to checkpoint', fall: 'Over the edge!', water: 'Splash!' }[kind];
  toast(`${text} (+${RESET_PENALTY} s)`);
  net.send({ t: 'event', kind });
}

// ---------- Input ----------
const keys = new Set();
addEventListener('keydown', (e) => {
  if (phase !== 'race') return;
  if (e.code === 'Escape') {
    if (performance.now() - lastAutoPause > 400) net.send({ t: 'pause', on: !paused });
    return;
  }
  if (paused) return;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'KeyM') toggleMute();
  if (role === 'driver' && e.code === 'KeyR' && performance.now() > raceStart && !finished) respawn('reset');
  if (role === 'passenger' && e.code === 'Space') mapUp = !mapUp;
  if (role === 'driver' && world?.vehicle !== 'boat' && !sim.state.auto && !finished) {
    if (e.code === 'KeyE') sim.shift(1);
    if (e.code === 'KeyQ') sim.shift(-1);
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const canvas = renderer.domElement;

// Esc while the mouse is captured makes the browser release it (the page never sees the key), so losing
// the pointer lock mid-stage counts as pressing Esc.
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (wasLocked && !locked && phase === 'race' && !paused) {
    lastAutoPause = performance.now();
    net.send({ t: 'pause', on: true });
  }
  wasLocked = locked;
});

// Pausing is shared: whoever pauses, the server tells both players.
function setPaused(on, by) {
  if (on && !paused) {
    paused = true;
    pauseAt = performance.now();
    keys.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    $('pausedBy').textContent = by
      ? `Paused by ${by === role ? 'you' : `your ${ROLE_NAME[by].toLowerCase()}`}. The game is paused for both of you.`
      : '';
  } else if (!on && paused) {
    paused = false;
    raceStart += performance.now() - pauseAt; // the clock (and countdown) skip the paused time
  }
  show('pause', paused);
}
$('resumeBtn').onclick = () => {
  net.send({ t: 'pause', on: false });
  canvas.requestPointerLock?.();
};
$('restartBtn').onclick = () => net.send({ t: 'restart' });
$('quitBtn').onclick = () => net.send({ t: 'to-lobby' });
$('sens').value = settings.sens;
$('sens').oninput = (e) => {
  settings.sens = Number(e.target.value);
  saveSettings();
};
$('gearbox').value = settings.gearbox;
$('gearbox').onchange = (e) => {
  settings.gearbox = e.target.value;
  saveSettings();
  if (sim && world?.vehicle !== 'boat') sim.state.auto = settings.gearbox === 'auto';
};
const wheelControls = ['wheelIndex', 'wheelAxis', 'throttleAxis', 'brakeAxis'];
for (const id of wheelControls) {
  const el = $(`wheel${id.slice(0, 1).toUpperCase()}${id.slice(1)}`);
  if (el) {
    el.value = settings[id];
    el.onchange = () => { settings[id] = Number(el.value); saveSettings(); };
  }
}
for (const [id, key] of [['wheelInvertSteer', 'invertSteer'], ['wheelInvertThrottle', 'invertThrottle'], ['wheelInvertBrake', 'invertBrake']]) {
  const el = $(id);
  el.checked = !!settings[key];
  el.onchange = () => { settings[key] = el.checked; saveSettings(); };
}
canvas.addEventListener('click', () => {
  if (phase === 'race' && !paused && document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
});
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  const k = 0.0022 * settings.sens;
  look.yaw = Math.max(-2.3, Math.min(2.3, look.yaw - e.movementX * k));
  look.pitch = Math.max(-1.2, Math.min(1.0, look.pitch - e.movementY * k));
});
addEventListener('mousedown', (e) => {
  if (e.button === 2 && phase === 'race' && role === 'passenger') rmbHeld = true;
});
addEventListener('mouseup', (e) => {
  if (e.button === 2) rmbHeld = false;
});
addEventListener('contextmenu', (e) => phase === 'race' && e.preventDefault());
addEventListener(
  'wheel',
  (e) => {
    if (phase !== 'race' || role !== 'passenger') return;
    mapZoom = Math.max(0.5, Math.min(4, mapZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
  },
  { passive: true },
);

const padShift = { up: false, down: false };
function readInput() {
  const k = (...codes) => codes.some((c) => keys.has(c));
  const inp = {
    throttle: k('KeyW', 'ArrowUp') ? 1 : 0,
    brake: k('KeyS', 'ArrowDown') ? 1 : 0,
    steer: (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0),
    hand: k('Space'),
  };
  const pads = navigator.getGamepads?.() || [];
  const gp = pads[settings.wheelIndex] || pads[0];
  if (gp) {
    const axisValue = (index, invert) => {
      if (index < 0) return 0;
      const raw = gp.axes[index] ?? 0;
      const normalized = (raw + 1) / 2;
      return invert ? 1 - normalized : normalized;
    };
    const deadzone = (v) => Math.abs(v) < 0.035 ? 0 : v;
    const steerAxis = deadzone(gp.axes[settings.wheelAxis] ?? 0) * (settings.invertSteer ? -1 : 1);
    const throttleAxis = axisValue(settings.throttleAxis, settings.invertThrottle);
    const brakeAxis = axisValue(settings.brakeAxis, settings.invertBrake);
    inp.throttle = Math.max(inp.throttle, gp.buttons[7]?.value || 0, throttleAxis);
    inp.brake = Math.max(inp.brake, gp.buttons[6]?.value || 0, brakeAxis);
    if (Math.abs(steerAxis) > 0) inp.steer = steerAxis;
    inp.hand ||= !!gp.buttons[0]?.pressed;
    // Bumpers shift (edge-triggered)
    const up = !!gp.buttons[5]?.pressed, down = !!gp.buttons[4]?.pressed;
    if (world?.vehicle !== 'boat' && !sim.state.auto && up && !padShift.up) sim.shift(1);
    if (world?.vehicle !== 'boat' && !sim.state.auto && down && !padShift.down) sim.shift(-1);
    Object.assign(padShift, { up, down });
  }
  return inp;
}

let muted = false;
function toggleMute() {
  if (!voice?.hasMic) return;
  muted = !muted;
  voice.setMuted(muted);
  toast(muted ? 'Mic muted' : 'Mic live');
}

// ---------- Networking ----------
const handlers = {
  welcome(m) {
    slot = m.slot;
    peer = m.peer;
    lobby = m.lobby;
    role = lobby.roles[slot];
    show('start', false);
    if (m.phase === 'race') startRace(-m.elapsed).then(() => setPaused(!!m.paused, m.pausedBy));
    else if (m.phase === 'results') {
      showLobby();
      showResults(m.results);
    } else showLobby();
  },
  full() {
    $('startMsg').textContent = 'That room already has two players. Try another room name.';
    $('joinBtn').disabled = $('joinNoMic').disabled = false;
  },
  'peer-joined'() {
    peer = true;
    toast('Your partner joined!');
    chime(audioCtx, false);
    voice.start(true); // whoever was already here makes the voice offer
    renderLobby();
    if (phase === 'race') {
      chars[OTHER[role]].group.visible = true;
      $('partnerStatus').textContent = `${ROLE_NAME[OTHER[role]]}: connected`;
    }
  },
  'peer-left'() {
    peer = false;
    voice.stop();
    carBuf.length = 0;
    toast('Your partner left');
    renderLobby();
    if (phase === 'race') {
      chars[OTHER[role]].group.visible = false;
      $('partnerStatus').textContent = `${ROLE_NAME[OTHER[role]]}: left`;
    }
  },
  lobby(m) {
    const mapChanged = lobby?.map !== m.lobby.map;
    const rejectedMap = pendingMap && m.lobby.map !== pendingMap;
    lobby = m.lobby;
    role = lobby.roles[slot];
    pendingMap = null;
    if (m.phase === 'lobby' && phase !== 'lobby') showLobby();
    else {
      renderLobby();
      if (rejectedMap) $('lobbyMsg').textContent = 'The room did not accept that stage change. Try again.';
      if (mapChanged && phase === 'lobby') ensureWorld(lobby.map);
    }
  },
  start(m) {
    lobby = m.lobby;
    startRace(m.delay);
  },
  results(m) {
    showResults(m.results);
  },
  pause(m) {
    if (phase === 'race') setPaused(m.on, m.by);
  },
  state(m) {
    if (phase !== 'race') return;
    partner.yaw = m.hy;
    partner.pitch = m.hp;
    if (m.role === 'driver' && role === 'passenger') {
      carBuf.push({ t: performance.now(), ...m });
      if (carBuf.length > 40) carBuf.shift();
      stats.pen = m.pen;
      progress = m.prog;
      car.rpm = m.rpm;
      car.g = m.g;
    } else if (m.role === 'passenger') {
      partner.mapUp = m.mu;
    }
  },
  event(m) {
    if (m.kind === 'checkpoint') {
      splits[m.n] = m.time;
      if (m.n < 3) toast(`Checkpoint ${m.n + 1} · ${fmtTime(m.time)}`);
      return;
    }
    const text = { reset: 'Driver reset to checkpoint', fall: 'Over the edge!', water: 'Splash!', wrong: 'Wrong turn!' }[m.kind];
    if (text) toast(m.kind === 'wrong' ? text : `${text} (+${RESET_PENALTY} s)`);
  },
  signal(m) {
    voice.onSignal(m.data);
  },
};

const roomInput = $('roomInput');
roomInput.value = params.get('room') || Math.random().toString(36).slice(2, 8);

async function join(withMic) {
  const room = roomInput.value.trim().replace(/[^\w-]/g, '').slice(0, 32) || 'lobby';
  roomInput.value = room;
  history.replaceState(null, '', `?room=${room}`);
  $('joinBtn').disabled = $('joinNoMic').disabled = true;
  $('startMsg').textContent = '';

  // The AudioContext must be created inside the click so the browser allows sound.
  audioCtx ||= new AudioContext();
  await audioCtx.resume();
  engine ||= createEngine(audioCtx, audioCtx.destination);
  voice ||= new Voice(audioCtx, (data) => net.send({ t: 'signal', data }), setVoiceStatus);
  if (withMic && !voice.hasMic && !(await voice.initMic())) toast('Mic blocked. You can still hear your partner.');

  net = connectNet(room, handlers, () => {
    if (phase !== 'start') {
      toast('Disconnected from server. Reload to rejoin.');
      $('partnerStatus').textContent = 'Disconnected';
    }
  });
}
$('joinBtn').addEventListener('click', () => join(true));
$('joinNoMic').addEventListener('click', () => join(false));

// ---------- Per-frame ----------
function driverStep(dt, now) {
  const live = now >= raceStart && !finished;
  const inp = live ? readInput() : NO_INPUT;
  sim.step(dt, world.vehicle === 'boat' ? { ...inp, hold: !live || finished } : inp);
  for (const ev of sim.events.splice(0)) thud(audioCtx, ev.strength);
  const c = sim.state;
  Object.assign(car, { x: c.x, y: c.y, z: c.z, h: c.h, p: c.pitch, r: c.roll, f: c.fwd, s: c.steer, th: c.throttle, rpm: c.rpm, g: c.gear });
  if (!live) return;

  const q = world.nearestRoad(c.x, c.z, world.half + 14);
  if (q && q.d < (world.vehicle === 'boat' ? world.half + 12 : ROAD_HALF + 3)) {
    if (q.road === world.main && q.i > progress && q.i - progress < 40) progress = q.i;
    if (q.road.kind === 'wrong' && q.i > 24 && !countedWrong.has(q.road.id)) {
      countedWrong.add(q.road.id);
      stats.wrong++;
      toast('Wrong turn!');
      net.send({ t: 'event', kind: 'wrong' });
    }
  }
  if (world.vehicle === 'boat' ? c.airTime > 4.5 : world.water != null && c.y < world.water - 0.4) respawn(world.vehicle === 'boat' ? 'fall' : 'water');
  else if (world.vehicle !== 'boat' && (c.airTime > 3.2 || (q && c.y < q.h - 15))) respawn('fall');

  // Checkpoint splits (the 4th "checkpoint" is the finish)
  while (splits.length < 4 && progress >= checkpoints[splits.length]) {
    const n = splits.length, time = (now - raceStart) / 1000 + stats.pen;
    splits.push(time);
    if (n < 3) {
      toast(`Checkpoint ${n + 1} · ${fmtTime(time)}`);
      chime(audioCtx, false);
    }
    net.send({ t: 'event', kind: 'checkpoint', n, time });
  }
  if (splits.length === 4) {
    finished = true;
    net.send({ t: 'finish', time: splits[3], pen: stats.pen, wrong: stats.wrong, resets: stats.resets, splits });
  }
}

function passengerStep(now) {
  const b = carBuf;
  if (!b.length) return;
  const rt = now - INTERP_DELAY_MS;
  while (b.length >= 2 && b[1].t <= rt) b.shift();
  let a = b[0], k = 0, c = b[0];
  if (b.length >= 2 && b[0].t <= rt) {
    c = b[1];
    k = (rt - a.t) / (c.t - a.t);
  }
  car.x = lerp(a.x, c.x, k);
  car.y = lerp(a.y, c.y, k);
  car.z = lerp(a.z, c.z, k);
  car.h = a.h + angleDiff(a.h, c.h) * k;
  car.p = lerp(a.p, c.p, k);
  car.r = lerp(a.r, c.r, k);
  car.f = lerp(a.f, c.f, k);
  car.s = lerp(a.s, c.s, k);
  car.th = c.th;
}

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
const eyeWorld = new THREE.Vector3();

function updateCabin(dt) {
  // Map pose: in the navigator's lap, or raised in front of their face.
  const navLook = role === 'passenger' ? look : partner;
  const wantUp = role === 'passenger' ? mapUp || rmbHeld : partner.mapUp;
  mapUpT += ((wantUp ? 1 : 0) - mapUpT) * Math.min(1, dt * 8);
  const eye = tmpA.copy(rig.seats.passenger).add(rig.eyeOffset || EYE);
  const cp = Math.cos(navLook.pitch);
  const dir = tmpB.set(Math.sin(navLook.yaw) * cp, Math.sin(navLook.pitch), Math.cos(navLook.yaw) * cp);
  const raised = eye.clone().addScaledVector(dir, 0.46).add(new THREE.Vector3(0, -0.06, 0));
  const lap = rig.seats.passenger.clone().add(new THREE.Vector3(0, rig.seatLift || 0.86, 0.3));
  mapMesh.position.lerpVectors(lap, raised, mapUpT);
  rig.group.updateMatrixWorld(true);
  mapMesh.lookAt(rig.group.localToWorld(eyeWorld.copy(eye)));
  mapMesh.updateMatrixWorld(true);

  // Heads
  const drvLook = role === 'driver' ? look : partner;
  chars.driver.setHead(drvLook.yaw, drvLook.pitch);
  chars.passenger.setHead(navLook.yaw, navLook.pitch);

  // Hands: driver on the wheel grips, navigator on the map edges.
  const toChar = (ch, obj, local) => ch.group.worldToLocal(local ? obj.localToWorld(local.clone()) : obj.getWorldPosition(new THREE.Vector3()));
  if (rig.grips) chars.driver.setHands(toChar(chars.driver, rig.grips[0]), toChar(chars.driver, rig.grips[1]));
  const [hl, hr] = mapMesh.userData.handles;
  chars.passenger.setHands(toChar(chars.passenger, mapMesh, hl), toChar(chars.passenger, mapMesh, hr));
  chars[OTHER[role]].setTalking(voice?.level || 0);
}

function renderProgressBar() {
  const el = $('progressTicks');
  el.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const tick = document.createElement('div');
    tick.className = 'cp';
    tick.style.bottom = `${(i + 1) * 25}%`;
    tick.innerHTML = `<span class="cp-label">${i < 3 ? `CP${i + 1}` : 'FINISH'}</span><span class="cp-time" id="split${i}"></span>`;
    el.append(tick);
  }
}

function updateHud(now) {
  const clock = paused ? pauseAt : now;
  const t = Math.max(0, (finished ? 0 : clock - raceStart) / 1000);
  // Progress bar: bottom = start, top = finish, split into 4 checkpoint sections
  const s0 = world.startIndex, total = world.main.s.length - 1 - s0;
  const frac = Math.max(0, Math.min(1, (progress - s0) / total));
  $('progressFill').style.height = `${frac * 100}%`;
  $('progressCar').style.bottom = `${frac * 100}%`;
  for (let i = 0; i < 4; i++) {
    const el = $(`split${i}`);
    if (!el) continue;
    el.textContent = splits[i] != null ? fmtTime(splits[i]) : '';
    el.parentElement.classList.toggle('done', splits[i] != null);
  }
  $('timer').textContent = fmtTime(t + stats.pen);
  $('pen').textContent = stats.pen ? `includes +${stats.pen} s penalty` : '';
  const cd = (raceStart - clock) / 1000;
  const center = $('center');
  if (cd > 0) center.textContent = cd > 3 ? 'Get ready' : String(Math.ceil(cd));
  else if (cd > -1) center.textContent = 'GO!';
  else center.textContent = '';
  center.classList.toggle('small-msg', cd > 3);
  show('lookHint', !paused && document.pointerLockElement !== canvas);
  $('micMeter').style.width = `${Math.min(100, (voice?.localLevel || 0) * 600)}%`;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (phase !== 'race' || !rig || !world) {
    // Slow flyover behind the menus.
    if (camera.parent !== scene) scene.add(camera);
    const t = now / 1000;
    camera.position.set(Math.cos(t * 0.04) * 620, 330, Math.sin(t * 0.04) * 620);
    camera.lookAt(0, 60, 0);
    sun.position.set(300, 500, 200);
    sun.target.position.set(0, 0, 0);
    renderer.render(scene, camera);
    return;
  }

  if (!paused) {
    if (role === 'driver') driverStep(dt, now);
    else passengerStep(now);
  }

  rig.group.position.set(car.x, car.y, car.z);
  rig.group.rotation.set(car.p, car.h, car.r, 'YXZ');
  rig.update(paused ? 0 : dt, car.f, car.s, car.rpm, car.g);
  updateCabin(dt);

  // First-person camera inside your own head, bounced by landings and bumps, rumbling with speed.
  const vy = (car.y - head.lastY) / Math.max(dt, 1e-3);
  const acc = Math.max(-400, Math.min(400, (vy - head.lastVy) / Math.max(dt, 1e-3)));
  head.lastY = car.y;
  head.lastVy = vy;
  head.vel += (-acc * 0.0022 - head.off * 140 - head.vel * 15) * dt;
  head.off = Math.max(-0.12, Math.min(0.12, head.off + head.vel * dt));
  const rumble = Math.min(1, Math.abs(car.f) / 35) * ((MAPS[worldMapId].mu ?? 1) < 0.95 ? 0.007 : 0.003) * (paused ? 0 : 1);
  camera.position.copy(rig.seats[role]).add(rig.eyeOffset || EYE);
  camera.position.y += head.off + (Math.random() - 0.5) * rumble;
  camera.rotation.set(look.pitch + (Math.random() - 0.5) * rumble * 0.6, Math.PI + look.yaw, (Math.random() - 0.5) * rumble * 0.4, 'YXZ');
  const fov = 72 + Math.min(10, Math.abs(car.f) * 0.2);
  if (Math.abs(camera.fov - fov) > 0.05) {
    camera.fov += (fov - camera.fov) * Math.min(1, dt * 4);
    camera.updateProjectionMatrix();
  }

  sun.position.set(car.x + 120, car.y + 220, car.z + 80);
  sun.target.position.set(car.x, car.y, car.z);

  // Map texture (navigator only; the driver just sees blank paper).
  if (role === 'passenger' && (mapAcc += dt) > 1 / 20) {
    mapAcc = 0;
    mapView.draw(car, mapZoom, progress);
  }

  // Audio: both of you are in the car, so both hear the engine; the partner's voice comes from their seat.
  camera.updateMatrixWorld();
  camera.getWorldPosition(tmpA);
  camera.getWorldDirection(tmpB);
  camera.getWorldQuaternion(tmpQ);
  setListener(audioCtx, tmpA, tmpB, new THREE.Vector3(0, 1, 0).applyQuaternion(tmpQ));
  engine.set(car.rpm, car.th, !paused);
  const partnerHead = chars[OTHER[role]].head.getWorldPosition(new THREE.Vector3());
  voice.update(partnerHead.x, partnerHead.y + 0.15, partnerHead.z);

  // Network
  if (!paused && (sendAcc += dt) >= 1 / SEND_HZ[role]) {
    sendAcc = 0;
    const r2 = (v) => Math.round(v * 100) / 100;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const msg = { t: 'state', role, hy: r3(look.yaw), hp: r3(look.pitch) };
    if (role === 'driver') {
      Object.assign(msg, {
        x: r2(car.x), y: r2(car.y), z: r2(car.z), h: r3(car.h), p: r3(car.p), r: r3(car.r),
        f: r2(car.f), s: r3(car.s), th: r2(car.th), pen: stats.pen, prog: progress, rpm: Math.round(car.rpm), g: car.g,
      });
    } else {
      msg.mu = mapUp || rmbHeld;
    }
    net.send(msg);
  }

  updateHud(now);
  if (!(role === 'driver' && lobby.vis === 'blindfold')) renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// Show a stage behind the start screen.
setTimeout(() => ensureWorld(params.get('map') && MAPS[params.get('map')] ? params.get('map') : 'alpine'), 50);

// Dev shortcuts: ?autojoin skips the start screen (no mic). Optional &role= &map= &vis= and &autostart.
if (params.has('autojoin')) {
  join(false).then(() =>
    setTimeout(() => {
      const set = {};
      for (const k of ['role', 'map', 'vis']) if (params.get(k)) set[k] = params.get(k);
      if (Object.keys(set).length) net.send({ t: 'set', ...set });
      if (params.has('autostart')) setTimeout(() => net.send({ t: 'start' }), 300);
    }, 600),
  );
}
