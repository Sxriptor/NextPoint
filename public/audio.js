export function makePanner(ctx, { model = 'inverse', ref = 1, max = 10000, rolloff = 1 } = {}) {
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = model;
  p.refDistance = ref;
  p.maxDistance = max;
  p.rolloffFactor = rolloff;
  return p;
}

export function setPannerPos(p, x, y, z) {
  if (p.positionX) {
    const t = p.context.currentTime;
    p.positionX.setTargetAtTime(x, t, 0.02);
    p.positionY.setTargetAtTime(y, t, 0.02);
    p.positionZ.setTargetAtTime(z, t, 0.02);
  } else {
    p.setPosition(x, y, z);
  }
}

// pos, fwd, up: {x, y, z}. Firefox lacks the AudioParam versions, so fall back to the old setters.
export function setListener(ctx, pos, fwd, up) {
  const l = ctx.listener;
  if (l.positionX) {
    const t = ctx.currentTime;
    l.positionX.setTargetAtTime(pos.x, t, 0.02);
    l.positionY.setTargetAtTime(pos.y, t, 0.02);
    l.positionZ.setTargetAtTime(pos.z, t, 0.02);
    l.forwardX.setTargetAtTime(fwd.x, t, 0.02);
    l.forwardY.setTargetAtTime(fwd.y, t, 0.02);
    l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
    l.upX.setTargetAtTime(up.x, t, 0.02);
    l.upY.setTargetAtTime(up.y, t, 0.02);
    l.upZ.setTargetAtTime(up.z, t, 0.02);
  } else {
    l.setPosition(pos.x, pos.y, pos.z);
    l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
  }
}

// Synthesized 4-cylinder engine: pitch follows RPM (firing frequency = rpm / 30), so shifts and the limiter are audible.
export function createEngine(ctx, dest, volume = 1) {
  const a = ctx.createOscillator();
  a.type = 'sawtooth';
  const b = ctx.createOscillator();
  b.type = 'square';
  const bGain = ctx.createGain();
  bGain.gain.value = 0.35;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 2;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  a.connect(filter);
  b.connect(bGain).connect(filter);
  filter.connect(gain).connect(dest);
  a.start();
  b.start();

  return {
    set(rpm, throttle, on = true) {
      const t = ctx.currentTime;
      const f = rpm / 30;
      a.frequency.setTargetAtTime(f, t, 0.02);
      b.frequency.setTargetAtTime(f * 0.5, t, 0.02);
      filter.frequency.setTargetAtTime(250 + rpm * 0.12 + throttle * 900, t, 0.05);
      gain.gain.setTargetAtTime(on ? (0.03 + throttle * 0.05 + rpm * 0.000006) * volume : 0, t, 0.08);
    },
  };
}

export function chime(ctx, big) {
  const t = ctx.currentTime;
  const notes = big ? [660, 880, 1320] : [880, 1320];
  notes.forEach((f, i) => {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const g = ctx.createGain();
    const st = t + i * 0.08;
    g.gain.setValueAtTime(0.0001, st);
    g.gain.exponentialRampToValueAtTime(0.16, st + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, st + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start(st);
    o.stop(st + 0.4);
  });
}

// Low thump for landings and impacts. strength ~ m/s.
let noiseBuf = null;
export function thud(ctx, strength) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 180;
  const g = ctx.createGain();
  g.gain.value = Math.min(1.2, strength / 12);
  src.connect(f).connect(g).connect(ctx.destination);
  src.start();
}

export function rmsLevel(analyser, buf) {
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}
