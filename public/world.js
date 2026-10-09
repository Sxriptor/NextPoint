import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GRID_STEP } from './terrain.js';
import { mulberry32, ROAD_HALF, MAP_HALF } from './shared.js';

const flat = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
const col = new THREE.Color();

// ---------- Terrain colouring ----------
const PALETTE = {
  alpine(h, ny, v) {
    if (h > 300 + v * 40 && ny > 0.55) return col.setHSL(0.6, 0.15, 0.93 + v * 0.04);
    if (ny < 0.72) return col.setHSL(0.08, 0.05, 0.42 + v * 0.1);
    if (h > 230) return col.setHSL(0.2, 0.25, 0.5 + v * 0.06);
    return col.setHSL(0.27 + v * 0.04, 0.4, 0.33 + v * 0.06);
  },
  desert(h, ny, v) {
    if (ny < 0.62) return col.set([0xb5562f, 0xc96c3a, 0xa84a2a, 0xd08550][Math.floor(Math.abs(h) / 7) % 4]).offsetHSL(0, 0, v * 0.04);
    if (h < 16) return col.setHSL(0.09, 0.5, 0.62 + v * 0.05);
    return col.setHSL(0.07 + v * 0.02, 0.55, 0.55 + v * 0.05);
  },
  forest(h, ny, v) {
    if (h < 1.5) return col.setHSL(0.11, 0.25, 0.42 + v * 0.05);
    if (ny < 0.7) return col.setHSL(0.08, 0.25, 0.32 + v * 0.06);
    return col.setHSL(0.26 + v * 0.05, 0.42, 0.24 + v * 0.06);
  },
  snow(h, ny, v) {
    if (ny < 0.66) return col.setHSL(0.6, 0.06, 0.48 + v * 0.1);
    return col.setHSL(0.58, 0.18, 0.88 + v * 0.07);
  },
  coast(h, ny, v) {
    if (h < 2.5) return col.setHSL(0.12, 0.45, 0.74 + v * 0.05); // beach
    if (ny < 0.68) return col.setHSL(0.09, 0.12, 0.55 + v * 0.1);
    return col.setHSL(0.2 + v * 0.05, 0.38, 0.4 + v * 0.07);
  },
  highland(h, ny, v) {
    if (ny < 0.7) return col.setHSL(0.1, 0.06, 0.4 + v * 0.1);
    if (v > 0.8) return col.setHSL(0.83, 0.18, 0.38 + v * 0.05); // heather
    return col.setHSL(0.19 + v * 0.05, 0.32, 0.36 + v * 0.06);
  },
  outback(h, ny, v) {
    if (ny < 0.65) return col.setHSL(0.03, 0.55, 0.36 + v * 0.06);
    return col.setHSL(0.05 + v * 0.02, 0.6, 0.45 + v * 0.06);
  },
  river(h, ny, v) {
    if (h < -0.5) return col.setHSL(0.56, 0.22, 0.28 + v * 0.05);
    if (h < 2.5) return col.setHSL(0.1, 0.24, 0.38 + v * 0.06);
    if (ny < 0.68) return col.setHSL(0.09, 0.18, 0.4 + v * 0.06);
    return col.setHSL(0.25 + v * 0.04, 0.38, 0.34 + v * 0.07);
  },
};

function terrainMesh(world, theme) {
  const { N, H } = world;
  const rng = mulberry32(99);
  const tris = (N - 1) * (N - 1) * 2;
  const pos = new Float32Array(tris * 9);
  const colors = new Float32Array(tris * 9);
  let k = 0;
  const v = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const paint = PALETTE[theme];

  const tri = () => {
    const [a, b, c] = v;
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nyN = ny / Math.hypot(nx, ny, nz);
    paint((a[1] + b[1] + c[1]) / 3, nyN, rng());
    for (const p of v) {
      pos[k] = p[0]; pos[k + 1] = p[1]; pos[k + 2] = p[2];
      colors[k] = col.r; colors[k + 1] = col.g; colors[k + 2] = col.b;
      k += 3;
    }
  };
  const set = (slot, i, j) => {
    v[slot][0] = -MAP_HALF + i * GRID_STEP;
    v[slot][1] = H[j * N + i];
    v[slot][2] = -MAP_HALF + j * GRID_STEP;
  };
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      set(0, i, j); set(1, i, j + 1); set(2, i + 1, j); tri();
      set(0, i + 1, j); set(1, i, j + 1); set(2, i + 1, j + 1); tri();
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.receiveShadow = true;
  return mesh;
}

// ---------- Roads ----------
// Strip between two lateral profiles [offset, yOffset] along the road samples.
function ribbon(samples, [o0, y0], [o1, y1], keep = () => true) {
  const pos = [];
  const p = (s, o, y) => [s.x + s.tz * o, s.h + y, s.z - s.tx * o];
  for (let i = 0; i < samples.length - 1; i++) {
    if (!keep(i)) continue;
    const a = samples[i], b = samples[i + 1];
    const a0 = p(a, o0, y0), a1 = p(a, o1, y1), b0 = p(b, o0, y0), b1 = p(b, o1, y1);
    pos.push(...a0, ...a1, ...b0, ...a1, ...b1, ...b0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function roadMeshes(world, map) {
  const group = new THREE.Group();
  const roadMat = flat(map.road, { side: THREE.DoubleSide });
  const lineMat = new THREE.MeshLambertMaterial({ color: 0xf2efe6, side: THREE.DoubleSide });
  const centerMat = new THREE.MeshLambertMaterial({ color: map.edgeLines ? 0xe9c34a : 0xd8d2c0, side: THREE.DoubleSide });
  const w = world.vehicle === 'boat' ? world.half : ROAD_HALF;
  const add = (geo, mat, receive = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = receive;
    group.add(m);
  };
  world.roads.forEach((road, idx) => {
    const s = road.s, lift = 0.05 + idx * 0.004; // tiny offset avoids flicker where roads overlap at forks
    add(ribbon(s, [w, lift], [-w, lift]), roadMat);
    add(ribbon(s, [w, lift], [w + 0.6, -1.4]), roadMat); // skirts hide gaps to the terrain
    add(ribbon(s, [-w, lift], [-w - 0.6, -1.4]), roadMat);
    if (map.edgeLines) {
      add(ribbon(s, [0.07, lift + 0.02], [-0.07, lift + 0.02], (i) => i % 4 < 2), centerMat);
      add(ribbon(s, [w - 0.3, lift + 0.02], [w - 0.45, lift + 0.02]), lineMat);
      add(ribbon(s, [-w + 0.3, lift + 0.02], [-w + 0.45, lift + 0.02]), lineMat);
    }
  });
  return group;
}

function bridgeMeshes(world) {
  const pillars = [], rails = [];
  for (const road of world.roads) {
    road.s.forEach((p, i) => {
      if (!p.bridge) return;
      if (i % 6 === 0) {
        const base = world.terrainHeight(p.x, p.z) - 1;
        const top = p.h - 1.2;
        if (top - base > 0.5) pillars.push({ x: p.x, z: p.z, y: base, hgt: top - base, rot: Math.atan2(p.tx, p.tz) });
      }
      const n = road.s[i + 1];
      if (n) for (const side of [-1, 1]) rails.push({ a: p, b: n, side });
    });
  }
  const group = new THREE.Group();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  if (pillars.length) {
    const geo = new THREE.BoxGeometry(1.4, 1, 1.4);
    geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, flat(0x8d8a84), pillars.length);
    pillars.forEach((p, i) => {
      q.setFromAxisAngle(UP, p.rot);
      mesh.setMatrixAt(i, m.compose(v.set(p.x, p.y, p.z), q, s.set(1, p.hgt, 1)));
    });
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (rails.length) {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.7, 1), flat(0xb8b4ac), rails.length);
    rails.forEach(({ a, b, side }, i) => {
      const o = (ROAD_HALF + 0.1) * side;
      const ax = a.x + a.tz * o, az = a.z - a.tx * o, bx = b.x + b.tz * o, bz = b.z - b.tx * o;
      q.setFromAxisAngle(UP, Math.atan2(bx - ax, bz - az));
      const len = Math.hypot(bx - ax, bz - az);
      mesh.setMatrixAt(i, m.compose(v.set((ax + bx) / 2, (a.h + b.h) / 2 + 0.4, (az + bz) / 2), q, s.set(1, 1, len)));
    });
    mesh.castShadow = true;
    group.add(mesh);
  }
  return group;
}

// ---------- Props ----------
function prop(...parts) {
  return mergeGeometries(parts.map(([geo, x = 0, y = 0, z = 0, rz = 0]) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.deleteAttribute('uv');
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    return g;
  }));
}

function propGeometries() {
  return {
    pine: [
      { geo: prop([new THREE.CylinderGeometry(0.25, 0.35, 2, 5), 0, 1]), color: () => col.set(0x5a3e2b) },
      {
        geo: prop([new THREE.ConeGeometry(1.8, 4, 6), 0, 3.6], [new THREE.ConeGeometry(1.3, 3, 6), 0, 5.4]),
        color: (v) => col.setHSL(0.3 + v * 0.06, 0.42, 0.18 + v * 0.1),
      },
    ],
    oak: [
      { geo: prop([new THREE.CylinderGeometry(0.3, 0.4, 2.4, 5), 0, 1.2]), color: () => col.set(0x5e4330) },
      {
        geo: prop([new THREE.IcosahedronGeometry(2.2, 0), 0, 3.8], [new THREE.IcosahedronGeometry(1.5, 0), 1.2, 4.4, 0.4]),
        color: (v) => (v > 0.75 ? col.setHSL(0.06 + v * 0.05, 0.65, 0.42) : col.setHSL(0.22 + v * 0.08, 0.45, 0.28 + v * 0.08)),
      },
    ],
    cactus: [
      {
        geo: prop(
          [new THREE.CylinderGeometry(0.32, 0.38, 3.2, 6), 0, 1.6],
          [new THREE.CylinderGeometry(0.2, 0.2, 0.8, 5), 0.5, 1.5, 0, Math.PI / 2],
          [new THREE.CylinderGeometry(0.2, 0.2, 1.1, 5), 0.85, 2.0],
          [new THREE.CylinderGeometry(0.18, 0.18, 0.7, 5), -0.45, 2.1, 0, Math.PI / 2],
          [new THREE.CylinderGeometry(0.18, 0.18, 0.8, 5), -0.75, 2.5],
        ),
        color: (v) => col.setHSL(0.28 + v * 0.05, 0.4, 0.3 + v * 0.08),
      },
    ],
    snowpine: [
      { geo: prop([new THREE.CylinderGeometry(0.25, 0.35, 2, 5), 0, 1]), color: () => col.set(0x4e3a2c) },
      {
        geo: prop([new THREE.ConeGeometry(1.8, 4, 6), 0, 3.6], [new THREE.ConeGeometry(1.3, 3, 6), 0, 5.4]),
        color: (v) => (v > 0.35 ? col.setHSL(0.58, 0.15, 0.86 + v * 0.08) : col.setHSL(0.36, 0.25, 0.22 + v * 0.1)),
      },
    ],
    palm: [
      {
        geo: prop(
          [new THREE.CylinderGeometry(0.16, 0.24, 3.2, 5), 0.1, 1.6, 0, -0.06],
          [new THREE.CylinderGeometry(0.13, 0.16, 3, 5), 0.35, 4.6, 0, -0.12],
        ),
        color: () => col.set(0x7a5c3e),
      },
      {
        geo: prop(
          [new THREE.ConeGeometry(0.5, 3.2, 4), 1.9, 5.8, 0, Math.PI / 2 + 0.35],
          [new THREE.ConeGeometry(0.5, 3.2, 4), -1.2, 5.8, 0, -Math.PI / 2 - 0.35],
          [new THREE.ConeGeometry(0.5, 2.8, 4), 0.4, 6.6, 0, 0.2],
        ),
        color: (v) => col.setHSL(0.25 + v * 0.06, 0.5, 0.3 + v * 0.08),
      },
    ],
    acacia: [
      { geo: prop([new THREE.CylinderGeometry(0.18, 0.28, 3, 5), 0, 1.5, 0, 0.12]), color: () => col.set(0x5b4130) },
      {
        geo: prop([new THREE.CylinderGeometry(3, 2.4, 0.9, 7), 0.2, 3.3], [new THREE.CylinderGeometry(1.8, 1.6, 0.7, 6), -0.8, 3.7]),
        color: (v) => col.setHSL(0.2 + v * 0.06, 0.32, 0.3 + v * 0.08),
      },
    ],
    reeds: [
      {
        geo: prop(
          [new THREE.CylinderGeometry(0.035, 0.07, 1.6, 4), -0.28, 0.8],
          [new THREE.CylinderGeometry(0.035, 0.07, 1.35, 4), 0.22, 0.675, 0, -0.18],
          [new THREE.CylinderGeometry(0.035, 0.07, 1.45, 4), 0.38, 0.725, 0, 0.22],
        ),
        color: (v) => col.setHSL(0.22 + v * 0.08, 0.42, 0.3 + v * 0.12),
      },
    ],
    rock: [{ geo: prop([new THREE.DodecahedronGeometry(1, 0)]), color: null }],
    shrub: [{ geo: prop([new THREE.IcosahedronGeometry(0.7, 0), 0, 0.35]), color: (v) => col.setHSL(0.12 + v * 0.06, 0.3, 0.38 + v * 0.1) }],
  };
}

const ROCK_COLOR = {
  alpine: (v) => col.setHSL(0.08, 0.04, 0.45 + v * 0.15),
  desert: (v) => col.setHSL(0.05, 0.45, 0.42 + v * 0.12),
  forest: (v) => col.setHSL(0.2, 0.08, 0.4 + v * 0.12),
  snow: (v) => col.setHSL(0.6, 0.05, 0.5 + v * 0.15),
  coast: (v) => col.setHSL(0.1, 0.1, 0.55 + v * 0.15),
  highland: (v) => col.setHSL(0.15, 0.04, 0.42 + v * 0.14),
  river: (v) => col.setHSL(0.08, 0.12, 0.38 + v * 0.14),
  outback: (v) => col.setHSL(0.03, 0.5, 0.34 + v * 0.1),
};

function propMeshes(world, theme) {
  const group = new THREE.Group();
  const geos = propGeometries();
  const byType = {};
  for (const p of world.props) (byType[p.type] ||= []).push(p);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3();
  const e = new THREE.Euler();
  for (const [type, list] of Object.entries(byType)) {
    for (const part of geos[type]) {
      const mesh = new THREE.InstancedMesh(part.geo, flat(0xffffff), list.length);
      list.forEach((p, i) => {
        if (type === 'rock') {
          e.set(p.v * 3, p.rot, p.v * 5);
          q.setFromEuler(e);
          s.set(p.s, p.s * (0.5 + p.v * 0.5), p.s * (0.8 + p.v * 0.4));
          v.set(p.x, p.y + p.s * 0.15, p.z);
        } else {
          q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, p.rot);
          s.set(p.s, p.s * (0.9 + p.v * 0.3), p.s);
          v.set(p.x, p.y - 0.1, p.z);
        }
        mesh.setMatrixAt(i, m.compose(v, q, s));
        mesh.setColorAt(i, (part.color || ROCK_COLOR[theme])(p.v));
      });
      mesh.castShadow = true;
      mesh.receiveShadow = type === 'rock';
      group.add(mesh);
    }
  }
  return group;
}

// ---------- Signs, barriers, finish ----------
function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function barrier(e) {
  const g = new THREE.Group();
  g.position.set(e.x, e.h, e.z);
  g.rotation.y = Math.atan2(e.tx, e.tz);
  const stripes = canvasTexture(256, 32, (ctx, w, h) => {
    ctx.fillStyle = '#f4f1ea';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#d0312d';
    for (let x = -h; x < w; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, h); ctx.lineTo(x + 20, h); ctx.lineTo(x + 20 + h, 0); ctx.lineTo(x + h, 0);
      ctx.fill();
    }
  });
  const boardMat = new THREE.MeshLambertMaterial({ map: stripes });
  const postMat = flat(0x6b5a48);
  for (const y of [0.6, 1.1]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF * 2 + 1, 0.3, 0.08), boardMat);
    b.position.y = y;
    b.castShadow = true;
    g.add(b);
  }
  for (const x of [-ROAD_HALF - 0.3, 0, ROAD_HALF + 0.3]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.5, 0.15), postMat);
    p.position.set(x, 0.75, -0.1);
    p.castShadow = true;
    g.add(p);
  }
  const signTex = canvasTexture(256, 80, (ctx, w, h) => {
    ctx.fillStyle = '#f2c230';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#1d1b18';
    ctx.lineWidth = 6;
    ctx.strokeRect(4, 4, w - 8, h - 8);
    ctx.fillStyle = '#1d1b18';
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ROAD CLOSED', w / 2, h / 2 + 2);
  });
  const sign = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 0.05), new THREE.MeshLambertMaterial({ map: signTex }));
  sign.position.y = 1.75;
  sign.rotation.y = Math.PI; // face oncoming traffic
  g.add(sign);
  return g;
}

// Main-route sample indices of the 3 checkpoints (25/50/75 %) and the finish trigger.
export function checkpointIndices(world) {
  const s0 = world.startIndex, last = world.main.s.length - 1;
  return [0.25, 0.5, 0.75].map((f) => Math.round(s0 + (last - s0) * f)).concat(last - 4);
}

function finishArch(f, label = 'FINISH', color = '#d0312d') {
  const g = new THREE.Group();
  g.position.set(f.x, f.h, f.z);
  g.rotation.y = Math.atan2(f.tx, f.tz);
  const postMat = flat(0x2b2b30);
  for (const x of [-ROAD_HALF - 0.8, ROAD_HALF + 0.8]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.35, 6, 0.35), postMat);
    p.position.set(x, 3, 0);
    p.castShadow = true;
    g.add(p);
  }
  const tex = canvasTexture(512, 64, (ctx, w, h) => {
    for (let x = 0; x < w / 16; x++) for (let y = 0; y < 4; y++) {
      ctx.fillStyle = (x + y) % 2 ? '#1d1b18' : '#f4f1ea';
      ctx.fillRect(x * 16, y * 16, 16, 16);
    }
    ctx.fillStyle = color;
    ctx.fillRect(w / 2 - 150, 6, 300, h - 12);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${label.length > 8 ? 34 : 44}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, w / 2, h / 2 + 2);
  });
  const banner = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF * 2 + 1.9, 1.2, 0.15), new THREE.MeshLambertMaterial({ map: tex }));
  banner.position.y = 5.6;
  banner.rotation.y = Math.PI;
  g.add(banner);
  const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 1.5), new THREE.MeshLambertMaterial({ map: tex }));
  line.rotation.x = -Math.PI / 2;
  line.position.y = 0.1;
  g.add(line);
  return g;
}

// ---------- Sky dressing ----------
function clouds() {
  const g = new THREE.Group();
  const rng = mulberry32(5);
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mat = flat(0xffffff, { emissive: 0x8a8a8a, transparent: true, opacity: 0.92 });
  for (let i = 0; i < 30; i++) {
    const c = new THREE.Group();
    const puffs = 3 + Math.floor(rng() * 3);
    for (let k = 0; k < puffs; k++) {
      const p = new THREE.Mesh(geo, mat);
      const s = 10 + rng() * 14;
      p.scale.set(s * 1.4, s * 0.7, s);
      p.position.set(k * 14 - puffs * 7, rng() * 5, (rng() - 0.5) * 12);
      c.add(p);
    }
    c.position.set((rng() - 0.5) * 1800, 520 + rng() * 120, (rng() - 0.5) * 1800);
    c.rotation.y = rng() * Math.PI;
    g.add(c);
  }
  return g;
}

function stars() {
  const rng = mulberry32(8);
  const pos = [];
  for (let i = 0; i < 1500; i++) {
    const a = rng() * Math.PI * 2, y = 0.08 + rng() * 0.92, r = Math.sqrt(1 - y * y);
    pos.push(Math.cos(a) * r * 1800, y * 1800, Math.sin(a) * r * 1800);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false }));
}

export function buildWorldMeshes(world, map) {
  const root = new THREE.Group();
  root.add(terrainMesh(world, map.theme));
  root.add(roadMeshes(world, map));
  root.add(bridgeMeshes(world));
  root.add(propMeshes(world, map.theme));
  for (const e of world.deadEnds) root.add(barrier(e));
  root.add(finishArch(world.finish));
  checkpointIndices(world)
    .slice(0, 3)
    .forEach((i, n) => root.add(finishArch(world.main.s[i], `CHECKPOINT ${n + 1}`, '#1f6fd1')));
  if (world.water != null) {
    const geo = new THREE.PlaneGeometry(MAP_HALF * 2, MAP_HALF * 2);
    geo.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x3d7fa6, transparent: true, opacity: 0.85 }));
    water.position.y = world.water;
    root.add(water);
  }
  root.userData.clouds = clouds();
  root.userData.stars = stars();
  root.add(root.userData.clouds, root.userData.stars);
  return root;
}

export function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      m.map?.dispose();
      m.dispose();
    }
  });
}

