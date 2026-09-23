// Synthetische Soundeffekte per WebAudio - keine Dateien noetig.
// Raeumlicher Klang: Geraeusche mit Position (x/y in Pixeln) werden je nach Richtung
// links/rechts verteilt und mit der Entfernung leiser. So hoert man, woher jemand kommt.

const TILE = 32;

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.listener = { x: 0, y: 0, yaw: 0 };
  }

  /** Hoerer = eigene Figur mit Blickrichtung (jeden Frame aktualisieren). */
  setListener(x, y, yaw) { this.listener.x = x; this.listener.y = y; this.listener.yaw = yaw; }

  /** Ausgang fuer ein Geraeusch: ohne Position direkt, mit Position ueber Panorama und Daempfung. */
  out(pos) {
    if (!pos) return this.master;
    const L = this.listener;
    const dx = pos.x - L.x, dy = pos.y - L.y;
    const dist = Math.hypot(dx, dy) / TILE;               // Meter
    if (dist > 45) return null;                           // zu weit weg
    const g = this.ctx.createGain();
    g.gain.value = 1 / (1 + dist / 6);
    let node = g;
    if (this.ctx.createStereoPanner && dist > 0.5) {
      const p = this.ctx.createStereoPanner();
      // rechts = (-sin yaw, cos yaw)
      const pan = (dx * -Math.sin(L.yaw) + dy * Math.cos(L.yaw)) / Math.max(1e-6, Math.hypot(dx, dy));
      p.pan.value = Math.max(-1, Math.min(1, pan)) * 0.85;
      g.connect(p); p.connect(this.master);
    } else g.connect(this.master);
    return node;
  }

  /** Browser erlauben Ton erst nach einer Nutzeraktion. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    } catch { this.ctx = null; }
  }

  tone({ freq = 440, to = null, type = 'sine', dur = 0.15, vol = 0.5, delay = 0, attack = 0.005, pos = null }) {
    if (!this.ctx || this.muted) return;
    const dest = this.out(pos);
    if (!dest) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g); g.connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  noise({ dur = 0.2, vol = 0.3, delay = 0, freq = 800, pos = null }) {
    if (!this.ctx || this.muted) return;
    const dest = this.out(pos);
    if (!dest) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(t0);
  }

  catchHit(pos) { this.noise({ dur: 0.25, vol: 0.5, freq: 400, pos }); this.tone({ freq: 220, to: 60, type: 'square', dur: 0.3, vol: 0.4, pos }); }
  lashMiss(pos) { this.tone({ freq: 900, to: 300, type: 'triangle', dur: 0.09, vol: 0.25, pos }); }
  /** Schuss des Farbmarkierers: kurzes Ploppen mit Zischen. */
  shot(pos) { this.noise({ dur: 0.12, vol: 0.35, freq: 1800, pos }); this.tone({ freq: 700, to: 180, type: 'square', dur: 0.1, vol: 0.18, pos }); }
  /** Schritt einer anderen Figur (leise, raeumlich). */
  step(pos, loud = false) { this.noise({ dur: 0.05, vol: loud ? 0.22 : 0.12, freq: 260 + Math.random() * 120, pos }); }
  scan() { this.tone({ freq: 300, to: 1400, type: 'sine', dur: 0.5, vol: 0.35 }); this.tone({ freq: 600, to: 2400, type: 'sine', dur: 0.5, vol: 0.15, delay: 0.05 }); }
  scanHit() { this.tone({ freq: 1200, type: 'square', dur: 0.08, vol: 0.3 }); this.tone({ freq: 1600, type: 'square', dur: 0.08, vol: 0.3, delay: 0.1 }); }
  grapple() { this.tone({ freq: 500, to: 1500, type: 'sawtooth', dur: 0.18, vol: 0.25 }); }
  grappleMiss() { this.tone({ freq: 400, to: 200, type: 'triangle', dur: 0.12, vol: 0.2 }); }
  absorb() { this.tone({ freq: 520, type: 'sine', dur: 0.12, vol: 0.3 }); this.tone({ freq: 780, type: 'sine', dur: 0.18, vol: 0.3, delay: 0.09 }); this.tone({ freq: 1040, type: 'sine', dur: 0.25, vol: 0.25, delay: 0.18 }); }
  decoy() { this.tone({ freq: 340, to: 500, type: 'triangle', dur: 0.15, vol: 0.25 }); }
  decoyPop(pos) { this.noise({ dur: 0.3, vol: 0.5, freq: 1500, pos }); this.tone({ freq: 800, to: 200, type: 'sawtooth', dur: 0.35, vol: 0.3, pos }); }
  dash(pos) { this.noise({ dur: 0.18, vol: 0.3, freq: 2500, pos }); }
  roundStart() { for (let i = 0; i < 3; i++) this.tone({ freq: 440 * Math.pow(2, i / 12 * 5), type: 'square', dur: 0.14, vol: 0.2, delay: i * 0.15 }); }
  huntStart() { this.tone({ freq: 220, type: 'sawtooth', dur: 0.8, vol: 0.3 }); this.tone({ freq: 330, type: 'sawtooth', dur: 0.8, vol: 0.25, delay: 0.1 }); }
  win() { [0, 4, 7, 12].forEach((s, i) => this.tone({ freq: 523 * Math.pow(2, s / 12), type: 'triangle', dur: 0.3, vol: 0.3, delay: i * 0.12 })); }
  lose() { [7, 3, 0].forEach((s, i) => this.tone({ freq: 330 * Math.pow(2, s / 12), type: 'triangle', dur: 0.35, vol: 0.3, delay: i * 0.18 })); }
  tick() { this.tone({ freq: 1000, type: 'square', dur: 0.04, vol: 0.12 }); }
  caught() { this.tone({ freq: 300, to: 80, type: 'sawtooth', dur: 0.6, vol: 0.4 }); }
}
