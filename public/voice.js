import { makePanner, setPannerPos, rmsLevel } from './audio.js';

// Public STUN only. Players behind strict NATs need a TURN server added here.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

// Peer-to-peer voice for exactly two players, placed at the partner's head inside the car.
// Graph: remote stream → HRTF panner (direction only, no distance falloff) → gain → speakers
export class Voice {
  constructor(ctx, sendSignal, onStatus) {
    this.ctx = ctx;
    this.sendSignal = sendSignal;
    this.onStatus = onStatus;
    this.pc = null;
    this.local = null;
    this.queue = Promise.resolve();
    this.level = 0;
    this.localLevel = 0;

    this.panner = makePanner(ctx, { rolloff: 0 });
    this.out = ctx.createGain();
    this.out.gain.value = 1.6;
    this.panner.connect(this.out).connect(ctx.destination);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.buf = new Uint8Array(this.analyser.fftSize);
  }

  async initMic() {
    try {
      this.local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      console.warn('Mic unavailable', err);
      return false;
    }
    this.localAnalyser = this.ctx.createAnalyser();
    this.localAnalyser.fftSize = 512;
    this.ctx.createMediaStreamSource(this.local).connect(this.localAnalyser); // meter only, not to speakers
    return true;
  }

  get hasMic() {
    return !!this.local;
  }

  setMuted(muted) {
    this.local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  start(offerer) {
    this.stop();
    const pc = (this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }));
    if (this.local) {
      for (const track of this.local.getTracks()) pc.addTrack(track, this.local);
    } else if (offerer) {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    pc.onicecandidate = (e) => e.candidate && this.sendSignal({ candidate: e.candidate.toJSON() });
    pc.ontrack = (e) => this.attach(e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => this.onStatus(pc.connectionState);
    this.onStatus('connecting');
    if (offerer) {
      this.queue = this.queue
        .then(async () => {
          await pc.setLocalDescription(await pc.createOffer());
          this.sendSignal({ sdp: pc.localDescription.toJSON() });
        })
        .catch((err) => console.warn('offer failed', err));
    }
  }

  // Signals are processed strictly in order so ICE candidates never race the SDP.
  onSignal(data) {
    this.queue = this.queue.then(() => this.handle(data)).catch((err) => console.warn('signal failed', err));
  }

  async handle(data) {
    if (data.sdp) {
      if (data.sdp.type === 'offer') this.start(false);
      const pc = this.pc;
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        this.sendSignal({ sdp: pc.localDescription.toJSON() });
      }
    } else if (data.candidate && this.pc) {
      await this.pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }

  attach(stream) {
    if (this.remoteStream === stream) return;
    this.remoteStream = stream;
    // Chrome only feeds remote WebRTC audio into Web Audio if a media element is also playing it.
    this.remoteEl ||= new Audio();
    this.remoteEl.muted = true;
    this.remoteEl.srcObject = stream;
    this.remoteEl.play().catch(() => {});
    this.remoteSrc?.disconnect();
    this.remoteSrc = this.ctx.createMediaStreamSource(stream);
    this.remoteSrc.connect(this.panner);
    this.remoteSrc.connect(this.analyser);
  }

  stop() {
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }
    this.remoteSrc?.disconnect();
    this.remoteSrc = null;
    this.remoteStream = null;
    if (this.remoteEl) this.remoteEl.srcObject = null;
    this.level = 0;
    this.onStatus('idle');
  }

  // Called every frame with the partner's head position (world space).
  update(px, py, pz) {
    setPannerPos(this.panner, px, py, pz);
    const remote = this.remoteSrc ? rmsLevel(this.analyser, this.buf) : 0;
    this.level += (remote - this.level) * 0.3;
    if (this.localAnalyser) {
      const l = rmsLevel(this.localAnalyser, this.buf);
      this.localLevel += (l - this.localLevel) * 0.3;
    }
  }
}
