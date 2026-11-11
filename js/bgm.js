// Web Audio で、その場で作る和風の BGM（音楽ファイルは使わない）
//   - 都節音階（ミヤコブシ: レ・ミ♭・ソ・ラ・シ♭）の琴のような音を、ゆっくりランダムに鳴らす
//   - 低い持続音（ドローン）と残響を重ねる

const BASE = 293.66; // D4
const SCALE = [0, 1, 5, 7, 8]; // 都節音階（半音の数）
const freqOf = (degree) => {
  const oct = Math.floor(degree / SCALE.length);
  const st = SCALE[((degree % SCALE.length) + SCALE.length) % SCALE.length] + 12 * oct;
  return BASE * 2 ** (st / 12);
};

export class Bgm {
  constructor() {
    this.ctx = null;
    this.playing = false;
    this.volume = 0.5;
    this.timer = null;
    this.degree = 4;
    this.beat = 0;
  }

  get supported() {
    return !!(window.AudioContext || window.webkitAudioContext);
  }

  init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    // 残響（ノイズを減衰させたインパルス応答）
    const len = Math.round(ctx.sampleRate * 3.2);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.6;
    }
    const reverb = ctx.createConvolver();
    reverb.buffer = ir;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.45;
    this.dry = ctx.createGain();
    this.dry.gain.value = 0.8;
    reverb.connect(this.wet).connect(this.master);
    this.dry.connect(this.master);
    this.reverbIn = reverb;

    // ドローン（レとラ）
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.045;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    droneGain.connect(lp);
    lp.connect(this.dry);
    lp.connect(reverb);
    for (const [f, det] of [[73.42, -4], [73.42, 5], [110, 0]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.detune.value = det;
      o.connect(droneGain);
      o.start();
    }
    // ゆっくり揺らす
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 0.02;
    lfo.connect(lfoGain).connect(droneGain.gain);
    lfo.start();

    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else if (this.playing) this.ctx.resume();
    });
  }

  // 琴のような音: 鋭い立ち上がり、明るさが早く落ちる、ゆっくり消える
  pluck(freq, time, vel = 0.25) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, time);
    out.gain.linearRampToValueAtTime(vel, time + 0.006);
    out.gain.exponentialRampToValueAtTime(vel * 0.3, time + 0.35);
    out.gain.exponentialRampToValueAtTime(0.0001, time + 3.2);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 2;
    filter.frequency.setValueAtTime(Math.min(9000, freq * 14), time);
    filter.frequency.exponentialRampToValueAtTime(freq * 2.2, time + 0.6);
    filter.connect(out);

    const parts = [['sawtooth', 1, 0.5], ['triangle', 1.002, 0.6], ['sine', 2, 0.15]];
    for (const [type, mul, g] of parts) {
      const o = ctx.createOscillator();
      o.type = type;
      // 弾いた瞬間に少しだけ音程が高い
      o.frequency.setValueAtTime(freq * mul * 1.012, time);
      o.frequency.exponentialRampToValueAtTime(freq * mul, time + 0.05);
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(filter);
      o.start(time);
      o.stop(time + 3.4);
    }
    out.connect(this.dry);
    out.connect(this.reverbIn);
  }

  nextDegree() {
    const r = Math.random();
    const step = r < 0.35 ? 1 : r < 0.7 ? -1 : r < 0.82 ? 2 : r < 0.94 ? -2 : 0;
    this.degree = Math.max(0, Math.min(10, this.degree + step));
    // 中心（レ）に少し戻りやすくする
    if (this.degree > 8 && Math.random() < 0.4) this.degree -= 2;
    if (this.degree < 2 && Math.random() < 0.4) this.degree += 2;
    return this.degree;
  }

  schedule() {
    const ctx = this.ctx;
    const beatLen = 60 / 66 / 2; // 8 分音符（テンポ 66）
    while (this.nextTime < ctx.currentTime + 0.25) {
      const t = this.nextTime;
      const bar = Math.floor(this.beat / 8);
      const inBar = this.beat % 8;
      const resting = bar % 4 === 3 && inBar >= 4; // 4 小節ごとに一息
      if (!resting) {
        const p = inBar === 0 ? 0.85 : inBar % 2 === 0 ? 0.45 : 0.18;
        if (Math.random() < p) {
          const d = this.nextDegree();
          const vel = 0.12 + Math.random() * 0.1 + (inBar === 0 ? 0.05 : 0);
          // 少しだけ揺れるタイミング
          this.pluck(freqOf(d), t + Math.random() * 0.02, vel);
          if (Math.random() < 0.15) this.pluck(freqOf(d - 3), t + 0.04, vel * 0.6);
        }
      }
      if (inBar === 0 && bar % 2 === 0) this.pluck(freqOf(-5 + (bar % 4 === 2 ? 3 : 0)), t, 0.16);
      this.beat++;
      this.nextTime += beatLen;
    }
  }

  async start() {
    if (!this.supported) return false;
    if (!this.ctx) this.init();
    await this.ctx.resume();
    if (this.playing) return true;
    this.playing = true;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this.volume, now, 0.6);
    this.nextTime = now + 0.1;
    this.beat = 0;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.schedule(), 60);
    return true;
  }

  stop() {
    if (!this.ctx || !this.playing) return;
    this.playing = false;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(0, now, 0.3);
    clearInterval(this.timer);
    setTimeout(() => { if (!this.playing) this.ctx.suspend(); }, 1500);
  }

  setVolume(v) {
    this.volume = v;
    if (this.ctx && this.playing) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }
}
