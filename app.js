'use strict';
/*
 * Spin Doctor — your phone is the platter.
 *
 * Physical model: a record platter spinning clockwise (viewed from above) plays
 * the song forward; counter-clockwise plays it in reverse. Spin rate maps 1:1
 * to playback rate — one revolution per CONFIG.REV_SEC seconds = normal speed
 * and pitch. Spin faster and the pitch climbs (chipmunk), slower and it drags.
 * Stop spinning and the record stops (silence, needle parked in the groove).
 *
 * Rotation sources (all combined):
 *   - deviceorientation gyro (phone flat on a table)
 *   - pointer drag on the record (with flick inertia)
 *   - mouse wheel
 *   - cruise button (auto-spin at listening speed)
 */

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const TAU = Math.PI * 2;
const mod = (n, m) => ((n % m) + m) % m;
const wrapPi = a => mod(a + Math.PI, TAU) - Math.PI;
const fmt = t => { t = Math.max(0, t | 0); return `${(t / 60) | 0}:${String(t % 60).padStart(2, '0')}`; };

const CONFIG = {
  REV_SEC: 1.8,        // seconds of audio per revolution at normal pitch (33⅓ RPM, like vinyl)
  MAX_RATE: 8,         // playback-rate clamp (chipmunk ceiling)
  START_RATE: 0.05,    // hysteresis: start audio above this |rate|
  STOP_RATE: 0.03,     // hysteresis: stop audio below this |rate|
  HAND_HALF_LIFE: 1.1, // flick inertia decay (seconds), pointer/wheel only
};

const state = {
  screen: 'library',
  tracks: [],
  current: null,
  platterAngle: 0,   // radians, positive = clockwise from above = forward
  gyroOmega: 0,      // rad/s from motion sensors
  handOmega: 0,      // rad/s from pointer/wheel (has inertia)
  lastGyroT: 0,
  cruise: true,
  cruiseOmega: TAU / CONFIG.REV_SEC,
  everSpun: false,
};

/* ================= audio engine =================
 * Position is tracked piecewise-linearly: (anchorPos, anchorT, rate).
 * Reverse playback uses a reversed copy of the decoded buffer; the needle
 * offset is mirrored. Both sources loop, so the platter never runs off the
 * edge of the song — it wraps, like a record that plays forever.
 */
const engine = {
  ctx: null, master: null, filter: null,
  buffer: null, revBuffer: null, duration: 0,
  src: null, dir: 0, rate: 0, anchorT: 0, anchorPos: 0,

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      this.filter = this.ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(this.filter);
      this.filter.connect(comp);
      comp.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },

  pos() {
    if (!this.duration) return 0;
    const el = this.src ? this.ctx.currentTime - this.anchorT : 0;
    return mod(this.anchorPos + el * this.rate, this.duration);
  },

  load(buf) {
    this.hold(0);
    this.buffer = buf;
    this.duration = buf.duration;
    this.revBuffer = reverseBuffer(this.ctx, buf);
    this.anchorPos = 0;
    this.anchorT = this.ctx.currentTime;
    this.dir = 0;
    this.rate = 0;
  },

  setRate(r) {
    if (!this.buffer || !this.ctx) return;
    r = clamp(r, -CONFIG.MAX_RATE, CONFIG.MAX_RATE);
    const a = Math.abs(r);
    if (this.src && a < CONFIG.STOP_RATE) { this.hold(); return; }
    if (!this.src && a < CONFIG.START_RATE) return;
    const dir = r >= 0 ? 1 : -1;
    if (!this.src || dir !== this.dir) {
      this.launch(this.pos(), dir, a);
    } else if (Math.abs(a - Math.abs(this.rate)) > 0.001) {
      const t = this.ctx.currentTime;
      this.anchorPos = this.pos();
      this.anchorT = t;
      this.rate = dir * a;
      this.src.playbackRate.setTargetAtTime(a, t, 0.03);
    }
    this.tone(a);
  },

  launch(pos, dir, a) {
    this.killSrc(0.03);
    const dur = this.duration;
    const off = dir > 0 ? mod(pos, dur) : dur - mod(pos, dur);
    const s = this.ctx.createBufferSource();
    s.buffer = dir > 0 ? this.buffer : this.revBuffer;
    s.loop = true;
    s.playbackRate.value = a;
    s.connect(this.master);
    s.start(0, off);
    this.src = s;
    this.dir = dir;
    this.rate = dir * a;
    this.anchorPos = mod(pos, dur);
    this.anchorT = this.ctx.currentTime;
  },

  hold(fade = 0.09) {
    if (!this.src) { this.tone(0); return; }
    const t = this.ctx.currentTime;
    this.anchorPos = this.pos();
    this.anchorT = t;
    this.rate = 0;
    this.killSrc(fade);
    this.tone(0);
  },

  killSrc(fade = 0.05) {
    if (!this.src) return;
    const s = this.src;
    this.src = null;
    try { s.stop(this.ctx.currentTime + fade); } catch (e) { /* already stopped */ }
  },

  // speed-dependent tone: slow = dark and quiet, fast = bright
  tone(a) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const g = this.src ? clamp(0.25 + a * 1.1, 0.25, 1) : 0;
    this.master.gain.setTargetAtTime(g, t, 0.03);
    const f = Math.min(20000, 500 + 19500 * Math.pow(Math.min(1, a), 0.8));
    this.filter.frequency.setTargetAtTime(f, t, 0.05);
  },
};

function reverseBuffer(ctx, buf) {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c);
    const d = out.getChannelData(c);
    const n = buf.length;
    for (let i = 0; i < n; i++) d[i] = s[n - 1 - i];
  }
  return out;
}

/* ---------- demo loop, synthesized on the fly ---------- */
async function makeDemoBuffer() {
  const sr = 44100, len = sr * 8;
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const oc = new OC(2, len, sr);
  const master = oc.createGain();
  master.gain.value = 0.8;
  master.connect(oc.destination);

  const noise = oc.createBuffer(1, sr * 0.1, sr);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  const blip = (f, t0, d, type, vol) => {
    const o = oc.createOscillator(), g = oc.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + d);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + d);
  };

  for (let bar = 0; bar < 4; bar++) {
    const t0 = bar * 2;
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * 0.5;
      const o = oc.createOscillator(), g = oc.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(160, t);
      o.frequency.exponentialRampToValueAtTime(44, t + 0.14);
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.25);
      const hs = oc.createBufferSource(); hs.buffer = noise;
      const hg = oc.createGain(), hf = oc.createBiquadFilter();
      hf.type = 'highpass'; hf.frequency.value = 7000;
      hg.gain.setValueAtTime(0.22, t + 0.25);
      hg.gain.exponentialRampToValueAtTime(0.001, t + 0.33);
      hs.connect(hf); hf.connect(hg); hg.connect(master);
      hs.start(t + 0.25);
    }
    [55, 55, 65.41, 49].forEach((f, i) => blip(f, t0 + i * 0.5, 0.45, 'square', 0.14));
  }
  const arp = [440, 523.25, 659.25, 880, 659.25, 523.25, 440, 392];
  for (let i = 0; i < 32; i++) blip(arp[i % 8], i * 0.25, 0.2, 'triangle', 0.11);
  return oc.startRendering();
}

/* ================= gyro =================
 * deviceorientation gives Euler angles (Z-X-Y intrinsic, W3C frame). Build the
 * quaternion, project the device's right-edge axis into the world horizontal
 * plane, and take its azimuth as the platter angle. Rotating the phone flat on
 * the table changes exactly that azimuth. The projection of the device's
 * up-axis onto world-up (squared) scales sensitivity, so standing the phone
 * upright and panning around barely moves the platter.
 */
const gyro = {
  supported: 'DeviceOrientationEvent' in window,
  needPerm: false,
  attached: false,
  active: false,
  dead: false,
  prevYaw: null,
  lastT: 0,
};

function quatFromDeviceOrientation(aDeg, bDeg, gDeg) {
  const D = Math.PI / 180;
  const z = aDeg * D / 2, x = bDeg * D / 2, y = gDeg * D / 2;
  const qz = [Math.cos(z), 0, 0, Math.sin(z)];
  const qx = [Math.cos(x), Math.sin(x), 0, 0];
  const qy = [Math.cos(y), 0, Math.sin(y), 0];
  return qmul(qmul(qz, qx), qy); // v_world = q · v_device · q*  ([w,x,y,z])
}

function qmul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

function qRot(q, v) {
  const [w, x, y, z] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function attachGyro() {
  if (gyro.attached) return;
  gyro.attached = true;
  window.addEventListener('deviceorientation', onOrient);
}

async function requestGyro() {
  try {
    if (gyro.needPerm) {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== 'granted') { toast('Motion permission denied — drag the record instead'); return; }
    }
    attachGyro();
    motionBtn.classList.add('hidden');
    setTimeout(() => {
      if (!gyro.active && state.screen === 'player') {
        toast('No motion sensor found here — drag the record or scroll');
      }
    }, 1500);
  } catch (err) {
    toast('Motion sensors unavailable — drag the record instead');
  }
}

function onOrient(e) {
  if (e.alpha == null || e.beta == null || e.gamma == null) { gyro.dead = true; return; }
  const now = performance.now();
  const dt = (now - gyro.lastT) / 1000;
  const q = quatFromDeviceOrientation(e.alpha, e.beta, e.gamma);
  const xw = qRot(q, [1, 0, 0]);
  const yaw = Math.atan2(xw[1], xw[0]);
  const up = qRot(q, [0, 0, 1]);
  const flat = clamp(up[2], 0, 1);
  if (gyro.prevYaw != null && dt > 0.001 && dt < 0.5) {
    // spec-frame yaw grows counter-clockwise from above; platter forward is clockwise
    const dEff = -wrapPi(yaw - gyro.prevYaw) * flat * flat;
    state.platterAngle += dEff;
    state.gyroOmega = state.gyroOmega * 0.7 + (dEff / dt) * 0.3;
    markSpun(Math.abs(state.gyroOmega));
  }
  gyro.prevYaw = yaw;
  gyro.lastT = now;
  state.lastGyroT = now;
  gyro.active = true;
}

/* ================= pointer / wheel ================= */
const drag = { active: false, prev: 0, t: 0 };
const platter = $('#platter');

function angleAt(e) {
  const r = platter.getBoundingClientRect();
  return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
}

platter.addEventListener('pointerdown', e => {
  drag.active = true;
  try { platter.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
  drag.prev = angleAt(e);
  drag.t = performance.now();
  state.handOmega = 0;
  e.preventDefault();
});
platter.addEventListener('pointermove', e => {
  if (!drag.active) return;
  const a = angleAt(e);
  const d = wrapPi(a - drag.prev); // screen y is down, so +d = clockwise = forward
  drag.prev = a;
  state.platterAngle += d;
  const now = performance.now();
  const dt = (now - drag.t) / 1000;
  if (dt > 0.008) {
    state.handOmega = state.handOmega * 0.6 + (d / dt) * 0.4;
    drag.t = now;
    markSpun(Math.abs(d / dt));
  }
});
['pointerup', 'pointercancel'].forEach(ev =>
  platter.addEventListener(ev, () => { drag.active = false; }));

$('#deck').addEventListener('wheel', e => {
  e.preventDefault();
  state.handOmega = clamp(state.handOmega - e.deltaY * 0.004, -40, 40);
  markSpun(Math.abs(state.handOmega));
}, { passive: false });

/* ================= main loop ================= */
const labelTitle = $('#labelTitle'), nowTitle = $('#nowTitle');
const rpmBadge = $('#rpmBadge'), pitchBadge = $('#pitchBadge'), timeBadge = $('#timeBadge');
const ringFg = $('#ringFg'), armG = $('#armG'), spinHint = $('#spinHint');
const RING_C = TAU * 48.5;

let lastFrame = performance.now();

function tick(dt) {
  if (!drag.active) {
    // flick inertia
    state.handOmega *= Math.exp(-dt * Math.LN2 / CONFIG.HAND_HALF_LIFE);
    if (Math.abs(state.handOmega) < 0.02) state.handOmega = 0;
    state.platterAngle += state.handOmega * dt;
  }
  // sensors stop firing when the phone sits still — decay so the song stops too
  if (performance.now() - state.lastGyroT > 150) {
    state.gyroOmega *= Math.exp(-dt * 6);
    if (Math.abs(state.gyroOmega) < 0.02) state.gyroOmega = 0;
  }

  const w = state.gyroOmega + state.handOmega + (state.cruise ? state.cruiseOmega : 0);
  engine.setRate(w * CONFIG.REV_SEC / TAU);

  // visuals
  platter.style.transform = `rotate(${state.platterAngle}rad)`;
  const dur = engine.duration;
  if (dur > 0) {
    const p = engine.pos() / dur;
    ringFg.setAttribute('stroke-dasharray', `${RING_C * p} ${RING_C}`);
    armG.setAttribute('transform', `rotate(${-16 + p * 32} 86 12)`);
    timeBadge.textContent = `${fmt(engine.pos())} / ${fmt(dur)}`;
  }
  const rpm = Math.abs(w) * 60 / TAU;
  rpmBadge.textContent = `${rpm.toFixed(1)} RPM`;
  rpmBadge.classList.toggle('live', rpm > 1);
  const rate = engine.src ? Math.abs(engine.rate) : 0;
  if (!engine.src) { pitchBadge.textContent = 'STOPPED'; pitchBadge.className = 'badge gray'; }
  else if (rate > 1.7) { pitchBadge.textContent = `🐿️ ×${rate.toFixed(1)}`; pitchBadge.className = 'badge squirrel'; }
  else if (rate < 0.6) { pitchBadge.textContent = `🐢 ×${rate.toFixed(1)}`; pitchBadge.className = 'badge slowed'; }
  else { pitchBadge.textContent = `×${rate.toFixed(1)}`; pitchBadge.className = 'badge'; }
}

function frame() {
  const now = performance.now();
  const dt = clamp((now - lastFrame) / 1000, 0.001, 0.05);
  lastFrame = now;
  if (state.screen === 'player') tick(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// A hidden tab freezes rAF, which would leave the audio stuck at the last
// spin rate — park the needle instead (cruise keeps playing, like a record).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { state.gyroOmega = 0; state.handOmega = 0; }
});

function markSpun(speed) {
  if (state.everSpun || (speed || 0) < 0.6) return;
  state.everSpun = true;
  spinHint.classList.add('gone');
}

/* ================= screens & tracks ================= */
const libraryEl = $('#library'), playerEl = $('#player');
const motionBtn = $('#motionBtn'), cruiseBtn = $('#cruiseBtn');
let wakeLock = null;

function showScreen(name) {
  state.screen = name;
  libraryEl.classList.toggle('hidden', name !== 'library');
  playerEl.classList.toggle('hidden', name !== 'player');
}

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* non-critical */ }
}

function prettyName(fname) {
  return fname.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || fname;
}

async function playTrack(t) {
  try {
    engine.ensure();
    showScreen('player');
    if (!t.buffer) {
      nowTitle.textContent = `Decoding ${t.title}…`;
      const file = await t.getFile();
      const ab = await file.arrayBuffer();
      t.buffer = await engine.ctx.decodeAudioData(ab);
    }
    engine.load(t.buffer);
    state.current = t;
    state.platterAngle = 0;
    nowTitle.textContent = t.title;
    labelTitle.textContent = t.title;
    motionBtn.classList.toggle('hidden', !gyro.needPerm || gyro.attached);
    keepAwake(true);
  } catch (err) {
    console.error(err);
    toast(`Couldn't decode “${t.title}”`);
    showScreen('library');
  }
}

function renderTracks() {
  const ul = $('#trackList');
  ul.innerHTML = '';
  state.tracks.forEach((t, i) => {
    const li = document.createElement('li');
    const num = document.createElement('span'); num.className = 'track-num'; num.textContent = String(i + 1);
    const name = document.createElement('span'); name.className = 'track-name'; name.textContent = t.title;
    const play = document.createElement('span'); play.className = 'track-play'; play.textContent = '▶';
    li.append(num, name, play);
    li.addEventListener('click', () => playTrack(t));
    ul.appendChild(li);
  });
  $('#emptyNote').classList.toggle('hidden', state.tracks.length > 0);
}

function setTracks(list) {
  state.tracks = list;
  renderTracks();
  if (list.length) toast(`${list.length} song${list.length > 1 ? 's' : ''} loaded`);
}

const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg|oga|flac|webm)$/i;

if ('showDirectoryPicker' in window) {
  $('#pickFolder').classList.remove('hidden');
  $('#pickFolder').addEventListener('click', async () => {
    try {
      const dir = await window.showDirectoryPicker();
      const tracks = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file' && AUDIO_RE.test(name)) {
          const h = handle;
          tracks.push({ title: prettyName(name), getFile: () => h.getFile() });
        }
      }
      tracks.sort((a, b) => a.title.localeCompare(b.title));
      setTracks(tracks);
    } catch (err) {
      if (err && err.name !== 'AbortError') toast('Could not open that folder');
    }
  });
}

$('#pickFiles').addEventListener('change', e => {
  const tracks = [...e.target.files]
    .filter(f => AUDIO_RE.test(f.name) || f.type.startsWith('audio/'))
    .map(f => ({ title: prettyName(f.name), getFile: () => Promise.resolve(f) }));
  tracks.sort((a, b) => a.title.localeCompare(b.title));
  setTracks(tracks);
});

$('#demoBtn').addEventListener('click', async () => {
  try {
    engine.ensure();
    const buf = await makeDemoBuffer();
    playTrack({ title: 'Demo Loop', getFile: () => null, buffer: buf });
  } catch (err) { toast('Demo failed to render'); }
});

/* ---------- microphone recording ----------
 * MediaRecorder captures the mic; the take is decoded with the same
 * decodeAudioData path as file tracks and dropped into the library, then
 * loaded straight onto the platter. Recordings live in memory for the
 * session only.
 */
const REC_MAX_MS = 30000;
const rec = {
  active: false, recorder: null, chunks: [], stream: null,
  analyser: null, meterRaf: 0, timerInt: 0, startT: 0, discard: false,
  count: 0,
};
const recBackdrop = $('#recBackdrop'), recTime = $('#recTime'), recLevelBar = $('#recLevelBar');

function pickRecMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
  if (rec.active) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    toast('Recording not supported in this browser'); return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    toast('Microphone unavailable — check permission'); return;
  }
  try {
    engine.ensure(); // shares the audio clock for the level meter
    rec.stream = stream;
    rec.chunks = [];
    rec.discard = false;
    const mime = pickRecMime();
    rec.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.recorder.ondataavailable = e => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    rec.recorder.onstop = onRecStopped;
    rec.recorder.start(250);
    rec.analyser = engine.ctx.createAnalyser();
    rec.analyser.fftSize = 512;
    engine.ctx.createMediaStreamSource(stream).connect(rec.analyser);
    rec.active = true;
    rec.startT = performance.now();
    recBackdrop.classList.remove('hidden');
    recTime.textContent = '0:00';
    rec.timerInt = setInterval(() => {
      recTime.textContent = fmt((performance.now() - rec.startT) / 1000);
    }, 250);
    meterLoop();
    setTimeout(() => { if (rec.active) stopRecording(); }, REC_MAX_MS);
  } catch (err) {
    console.error(err);
    stream.getTracks().forEach(t => t.stop());
    toast('Could not start recording');
  }
}

function meterLoop() {
  if (!rec.active || !rec.analyser) return;
  const data = new Uint8Array(rec.analyser.fftSize);
  rec.analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
  const rms = Math.sqrt(sum / data.length);
  recLevelBar.style.width = `${Math.min(100, rms * 260)}%`;
  rec.meterRaf = requestAnimationFrame(meterLoop);
}

function stopRecording() {
  if (!rec.active) return;
  clearInterval(rec.timerInt);
  cancelAnimationFrame(rec.meterRaf);
  recBackdrop.classList.add('hidden');
  rec.active = false;
  if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
}

function cancelRecording() {
  rec.discard = true;
  stopRecording();
}

function addRecording(blob) {
  rec.count += 1;
  const t = { title: `Recording ${rec.count}`, getFile: () => Promise.resolve(blob) };
  state.tracks.push(t);
  renderTracks();
  playTrack(t);
}

function onRecStopped() {
  rec.stream.getTracks().forEach(t => t.stop());
  rec.stream = null;
  rec.analyser = null;
  if (rec.discard || !rec.chunks.length) {
    rec.chunks = [];
    if (!rec.discard) toast('Nothing recorded');
    return;
  }
  const blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || 'audio/webm' });
  rec.chunks = [];
  addRecording(blob);
}

$('#recBtn').addEventListener('click', startRecording);
$('#recStop').addEventListener('click', stopRecording);
$('#recCancel').addEventListener('click', cancelRecording);

$('#backBtn').addEventListener('click', () => {
  engine.hold();
  keepAwake(false);
  showScreen('library');
});

cruiseBtn.addEventListener('click', () => {
  state.cruise = !state.cruise;
  cruiseBtn.setAttribute('aria-pressed', String(state.cruise));
  markSpun(1);
});

motionBtn.addEventListener('click', requestGyro);

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

/* ================= init ================= */
if (gyro.supported) {
  gyro.needPerm = typeof DeviceOrientationEvent.requestPermission === 'function';
  if (!gyro.needPerm) attachGyro(); // Android / desktop: no permission gate
}
showScreen('library');
renderTracks();
window.__spin = { state, engine, CONFIG, gyro, tick, addRecording }; // debug handle
