// Malmodus: Pinsel auf dem eigenen Koerper, Pipette aus der Umgebung,
// Helligkeit, Pinselgroesse, Rueckgaengig, Fuellen. Synchronisiert die
// Textur als PNG an den Server.

import * as THREE from 'three';
import * as C from '/shared/constants.js';
import { sampleWorldColor } from './world.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Painter {
  constructor(renderer, input, net) {
    this.renderer = renderer;
    this.input = input;
    this.net = net;
    this.active = false;
    this.color = [92, 128, 86];
    this.lightness = 0;
    this.brush = C.BRUSH_DEFAULT;
    this.undo = [];
    this.recent = [];
    this.lastUV = null;
    this.lastPart = null;
    this.stroking = false;
    this.dirty = false;
    this.lastSync = 0;
    this.raycaster = new THREE.Raycaster();
    this.el = {
      panel: $('paint-panel'), swatch: $('paint-swatch'), light: $('paint-light'), size: $('paint-size'),
      sizeVal: $('paint-size-val'), recent: $('paint-recent'), hint: $('paint-hint'),
      btnFill: $('paint-fill'), btnUndo: $('paint-undo'), btnClear: $('paint-clear'), btnDone: $('paint-done'), btnEye: $('paint-eye'),
    };
    this.el.light.oninput = () => { this.lightness = Number(this.el.light.value); this.updateSwatch(); };
    this.el.size.oninput = () => { this.brush = Number(this.el.size.value); this.el.sizeVal.textContent = String(this.brush); };
    this.el.btnFill.onclick = () => this.fillAll();
    this.el.btnUndo.onclick = () => this.undoStroke();
    this.el.btnClear.onclick = () => this.clear();
    this.el.btnDone.onclick = () => this.setActive(false);
    this.el.btnEye.onclick = () => this.eyedrop();
    input.onEyedrop = () => this.eyedrop();
    input.onWheel = (dir) => { this.brush = clamp(this.brush - dir * 2, C.BRUSH_MIN, C.BRUSH_MAX); this.el.size.value = String(this.brush); this.el.sizeVal.textContent = String(this.brush); };
    this.updateSwatch();
  }

  get canvas() { return this.renderer.me?.userData.canvas; }
  get texture() { return this.renderer.me?.userData.texture; }

  /** Endgueltige Pinselfarbe: Grundfarbe mit Helligkeitsversatz. */
  finalColor() {
    const l = this.lightness;
    return this.color.map((v) => clamp(Math.round(v + l), 0, 255));
  }

  updateSwatch() {
    const c = this.finalColor();
    this.el.swatch.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
    this.el.swatch.textContent = `${c[0]}, ${c[1]}, ${c[2]}`;
  }

  setActive(on) {
    if (this.active === on) return;
    this.active = on;
    this.input.setPaintMode(on);
    this.el.panel.hidden = !on;
    document.body.classList.toggle('painting', on);
    if (!on) { this.endStroke(); this.sync(true); }
    else this.renderer.chooseOrbit(this.input.look.yaw + Math.PI);
  }

  toggle() { this.setActive(!this.active); }

  /** Farbe von der Oberflaeche unter dem Cursor aufnehmen. */
  eyedrop() {
    if (!this.active || !this.renderer.world) return;
    const hit = this.renderer.pickWorld(this.input.mouse.x, this.input.mouse.y);
    const c = sampleWorldColor(this.renderer.world, hit);
    if (!c) { this.el.hint.textContent = 'Nichts unter dem Cursor – zeige auf Wand oder Boden.'; return; }
    this.color = c;
    this.lightness = 0; this.el.light.value = '0';
    this.updateSwatch();
    this.pushRecent(c);
    this.el.hint.textContent = 'Farbe aufgenommen. Linke Maustaste: auf den Körper malen.';
  }

  pushRecent(c) {
    const key = c.join(',');
    this.recent = [c, ...this.recent.filter((r) => r.join(',') !== key)].slice(0, 8);
    this.el.recent.innerHTML = '';
    for (const r of this.recent) {
      const b = document.createElement('button');
      b.className = 'sw';
      b.style.background = `rgb(${r[0]},${r[1]},${r[2]})`;
      b.title = r.join(', ');
      b.onclick = () => { this.color = r.slice(); this.lightness = 0; this.el.light.value = '0'; this.updateSwatch(); };
      this.el.recent.appendChild(b);
    }
  }

  snapshot() {
    const cv = this.canvas; if (!cv) return;
    const ctx = cv.getContext('2d');
    this.undo.push(ctx.getImageData(0, 0, cv.width, cv.height));
    if (this.undo.length > 12) this.undo.shift();
  }

  undoStroke() {
    const cv = this.canvas; if (!cv || !this.undo.length) return;
    cv.getContext('2d').putImageData(this.undo.pop(), 0, 0);
    this.texture.needsUpdate = true;
    this.dirty = true;
    this.sync(true);
  }

  fillAll() {
    const cv = this.canvas; if (!cv) return;
    this.snapshot();
    const c = this.finalColor();
    const ctx = cv.getContext('2d');
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillRect(0, 0, cv.width, cv.height);
    this.texture.needsUpdate = true;
    this.dirty = true;
    this.sync(true);
  }

  clear() {
    const cv = this.canvas; if (!cv) return;
    this.snapshot();
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#f2f2f0';
    ctx.fillRect(0, 0, cv.width, cv.height);
    this.texture.needsUpdate = true;
    this.dirty = true;
    this.sync(true);
  }

  /** Pro Frame: Pinselstriche auf dem eigenen Koerper, Kameradrehung. */
  update(now) {
    if (!this.active || !this.renderer.me) return;
    const drag = this.input.takeDrag();
    if (drag.dx || drag.dy) {
      this.renderer.orbit.yaw += drag.dx * 0.006;
      this.renderer.orbit.pitch = clamp(this.renderer.orbit.pitch - drag.dy * 0.006, -0.6, 1.2);
    }
    if (this.input.mouse.left) {
      const hit = this.renderer.pickSelf(this.input.mouse.x, this.input.mouse.y);
      if (hit && hit.uv) {
        if (!this.stroking) { this.stroking = true; this.snapshot(); this.lastUV = null; }
        this.dab(hit.uv, hit.object.userData.part);
      } else this.lastUV = null;
      if (now - this.lastSync > 400) this.sync(false);
    } else if (this.stroking) {
      this.endStroke();
      this.sync(true);
    }
  }

  endStroke() { this.stroking = false; this.lastUV = null; this.lastPart = null; }

  /** Einen Pinseltupfer setzen, bei durchgehendem Strich Zwischenpunkte fuellen. */
  dab(uv, part) {
    const cv = this.canvas; if (!cv) return;
    const ctx = cv.getContext('2d');
    const c = this.finalColor();
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    const T = cv.width;
    const x = uv.x * T, y = (1 - uv.y) * T;
    const r = this.brush / 2;
    const dot = (px, py) => { ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); };
    if (this.lastUV && this.lastPart === part) {
      const lx = this.lastUV.x * T, ly = (1 - this.lastUV.y) * T;
      const d = Math.hypot(x - lx, y - ly);
      const n = Math.max(1, Math.ceil(d / (r * 0.5)));
      // Nur innerhalb desselben Atlasfeldes verbinden, sonst springt der Strich ueber den Koerper.
      if (d < T / 4) for (let i = 1; i <= n; i++) dot(lx + (x - lx) * (i / n), ly + (y - ly) * (i / n));
      else dot(x, y);
    } else dot(x, y);
    this.lastUV = { x: uv.x, y: uv.y };
    this.lastPart = part;
    this.texture.needsUpdate = true;
    this.dirty = true;
  }

  /** Durchschnittsfarbe der Textur (grob, fuer Bots und Farbspuren). */
  average() {
    const cv = this.canvas;
    const small = this.smallCanvas ?? (this.smallCanvas = document.createElement('canvas'));
    small.width = 16; small.height = 16;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(cv, 0, 0, 16, 16);
    const d = sctx.getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }

  /** Textur an den Server schicken (gedrosselt). */
  sync(force) {
    if (!this.dirty || !this.canvas) return;
    const now = performance.now();
    if (!force && now - this.lastSync < 400) return;
    this.lastSync = now;
    this.dirty = false;
    const png = this.canvas.toDataURL('image/png');
    if (png.length > C.PAINT_MAX_BYTES) { this.el.hint.textContent = 'Bemalung zu detailliert für den Versand – etwas vereinfachen.'; return; }
    this.net?.send({ t: 'paint', paint: { png }, avg: this.average() });
  }

  /** Bei Rundenstart: alles zuruecksetzen. */
  reset() {
    this.undo = [];
    this.endStroke();
    this.dirty = false;
    if (this.active) this.setActive(false);
  }
}
