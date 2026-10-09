import * as THREE from 'three';
import { MAP_HALF, mulberry32 } from './shared.js';

// The navigator's paper map: a canvas drawn heading-up around the car, used as a texture.
const W = 768, H = 576;
const PAPER = '#efe4c8';
const RELIEF = 512;

const TINTS = {
  alpine: { low: [196, 214, 160], high: [240, 236, 226], max: 450, contour: 50 },
  desert: { low: [238, 206, 150], high: [190, 112, 70], max: 120, contour: 30 },
  forest: { low: [178, 208, 140], high: [112, 150, 92], max: 90, contour: 30 },
  snow: { low: [226, 232, 238], high: [168, 180, 196], max: 120, contour: 30 },
  coast: { low: [200, 214, 150], high: [176, 150, 112], max: 160, contour: 40 },
  highland: { low: [184, 200, 140], high: [150, 128, 140], max: 150, contour: 30 },
  outback: { low: [232, 170, 120], high: [176, 84, 52], max: 70, contour: 15 },
};

function buildRelief(world) {
  const c = document.createElement('canvas');
  c.width = c.height = RELIEF;
  const g = c.getContext('2d');
  const img = g.createImageData(RELIEF, RELIEF);
  const tint = { ...TINTS[world.map.theme], ...(world.map.tintMax && { max: world.map.tintMax, contour: world.map.tintMax / 9 }) };
  const px = (MAP_HALF * 2) / RELIEF;
  for (let v = 0; v < RELIEF; v++) {
    for (let u = 0; u < RELIEF; u++) {
      const x = -MAP_HALF + (u + 0.5) * px, z = -MAP_HALF + (v + 0.5) * px;
      const h = world.terrainHeight(x, z);
      const hx = world.terrainHeight(x + px, z) - h, hz = world.terrainHeight(x, z + px) - h;
      const shade = Math.max(0.55, Math.min(1.15, 1 - (hx * 0.7 + hz * 0.5) / px * 0.35));
      const t = Math.max(0, Math.min(1, h / tint.max));
      let r = tint.low[0] + (tint.high[0] - tint.low[0]) * t;
      let gg = tint.low[1] + (tint.high[1] - tint.low[1]) * t;
      let b = tint.low[2] + (tint.high[2] - tint.low[2]) * t;
      if (world.water != null && h < world.water) [r, gg, b] = [120, 170, 200];
      const contour = Math.floor(h / tint.contour) !== Math.floor((h + Math.max(Math.abs(hx), Math.abs(hz))) / tint.contour) ? 0.85 : 1;
      const k = shade * contour, i = (v * RELIEF + u) * 4;
      img.data[i] = r * k;
      img.data[i + 1] = gg * k;
      img.data[i + 2] = b * k;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

export function createMapView() {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  let world = null, relief = null;

  function paperFrame() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const grd = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.7);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, 'rgba(90,60,20,0.35)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(90,70,40,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath(); // fold creases
    ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H);
    ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
    ctx.stroke();
    ctx.strokeStyle = '#5a4630';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
  }

  return {
    texture,
    setWorld(w) {
      world = w;
      relief = buildRelief(w);
    },

    // What the driver sees when glancing over: a map with nothing legible on it.
    drawBlank() {
      const rng = mulberry32(4);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(80,70,60,0.25)';
      ctx.lineWidth = 3;
      for (let i = 0; i < 14; i++) {
        ctx.beginPath();
        let x = rng() * W, y = rng() * H;
        ctx.moveTo(x, y);
        for (let k = 0; k < 6; k++) ctx.lineTo((x += (rng() - 0.5) * 160), (y += (rng() - 0.5) * 160));
        ctx.stroke();
      }
      paperFrame();
      texture.needsUpdate = true;
    },

    // car: {x, z, h}. zoom: px per meter. progress: furthest main-route sample reached.
    draw(car, zoom, progress) {
      if (!world) return;
      const s = zoom, cos = Math.cos(car.h), sin = Math.sin(car.h);
      // World (x, z) → canvas, heading up: the car's right is the canvas right.
      const a = -s * cos, b = -s * sin, c = s * sin, d = -s * cos;
      const ox = W / 2, oy = H * 0.66;
      const e = ox - (a * car.x + c * car.z), f = oy - (b * car.x + d * car.z);
      const toS = (x, z) => [a * x + c * z + e, b * x + d * z + f];

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, W, H);
      ctx.setTransform(a, b, c, d, e, f);
      ctx.globalAlpha = 0.95;
      ctx.drawImage(relief, -MAP_HALF, -MAP_HALF, MAP_HALF * 2, MAP_HALF * 2);
      ctx.globalAlpha = 1;

      ctx.lineCap = ctx.lineJoin = 'round';
      const stroke = (pts, from, to, color, px) => {
        ctx.beginPath();
        ctx.moveTo(pts[from].x, pts[from].z);
        for (let i = from + 1; i <= to; i++) ctx.lineTo(pts[i].x, pts[i].z);
        ctx.strokeStyle = color;
        ctx.lineWidth = px / s;
        ctx.stroke();
      };
      for (const r of world.roads) stroke(r.s, 0, r.s.length - 1, '#3b3328', 11);
      for (const r of world.roads) if (r.kind === 'wrong') stroke(r.s, 0, r.s.length - 1, '#d8402f', 6);
      const m = world.main.s;
      stroke(m, 0, m.length - 1, '#2f9e58', 6);
      if (progress > 1) stroke(m, 0, Math.min(progress, m.length - 1), '#9a9384', 6);

      // Screen-space markers
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = 'bold 17px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const r of world.roads) {
        if (r.kind !== 'wrong') continue;
        const [fx, fy] = toS(r.s[0].x, r.s[0].z);
        ctx.fillStyle = '#fff8e8';
        ctx.strokeStyle = '#3b3328';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(fx, fy, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        const end = r.s[r.s.length - 1];
        const [x, y] = toS(end.x, end.z);
        ctx.fillStyle = '#b3261e';
        ctx.fillText(r.end === 'cliff' ? '▼ CLIFF' : '✕ DEAD END', x, y - 16);
      }
      for (const c of world.crests) {
        const [x, y] = toS(c.x, c.z);
        if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
        ctx.fillStyle = '#1d1b18';
        ctx.beginPath();
        ctx.moveTo(x, y - 9);
        ctx.lineTo(x + 8, y + 5);
        ctx.lineTo(x - 8, y + 5);
        ctx.closePath();
        ctx.fill();
        ctx.font = 'bold 14px system-ui, sans-serif';
        ctx.fillText('JUMP', x, y + 17);
      }
      ctx.font = 'bold 17px system-ui, sans-serif';
      const fin = world.finish;
      const [fx, fy] = toS(fin.x, fin.z);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
        ctx.fillStyle = (i + j) % 2 ? '#1d1b18' : '#fff';
        ctx.fillRect(fx - 12 + i * 6, fy - 26 + j * 6, 6, 6);
      }
      ctx.fillStyle = '#1d1b18';
      ctx.fillRect(fx - 13, fy - 26, 2, 30);
      ctx.fillText('FINISH', fx, fy + 14);

      // You are here
      ctx.fillStyle = '#1f6fd1';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(ox, oy - 16);
      ctx.lineTo(ox + 11, oy + 12);
      ctx.lineTo(ox, oy + 6);
      ctx.lineTo(ox - 11, oy + 12);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Compass (north = -z)
      const [nx, ny] = [a * 0 + c * -1, b * 0 + d * -1];
      const nl = Math.hypot(nx, ny);
      const cx = W - 46, cy = 46;
      ctx.fillStyle = 'rgba(255,248,232,0.85)';
      ctx.beginPath();
      ctx.arc(cx, cy, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#b3261e';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + (nx / nl) * 20, cy + (ny / nl) * 20);
      ctx.stroke();
      ctx.fillStyle = '#3b3328';
      ctx.fillText('N', cx + (nx / nl) * 34 * 0.6, cy + (ny / nl) * 34 * 0.6 - 0);

      // Distance left + scale bar
      const left = Math.max(0, (m.length - 1 - progress) * 2.5);
      ctx.textAlign = 'left';
      ctx.font = 'bold 22px system-ui, sans-serif';
      ctx.fillStyle = '#3b3328';
      ctx.fillText(left > 999 ? `${(left / 1000).toFixed(1)} km to finish` : `${Math.round(left)} m to finish`, 20, 32);
      ctx.fillRect(20, H - 30, 100 * s, 4);
      ctx.font = '15px system-ui, sans-serif';
      ctx.fillText('100 m', 20, H - 44);

      paperFrame();
      texture.needsUpdate = true;
    },
  };
}
