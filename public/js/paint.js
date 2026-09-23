// Malmodus: Pinsel auf dem eigenen Koerper, Pipette aus der Umgebung,
// Helligkeit, Pinselgroesse, Rueckgaengig, Fuellen. Synchronisiert die
// Textur als PNG an den Server.

import * as THREE from 'three';
import * as C from '/shared/constants.js';
import { sampleWorldColor } from './world.js';
import { surfaceColor } from '/shared/map.js';
import { raycast3D, colorMatch } from '/shared/physics.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// Atlas: 4x4 Felder je Koerperteil, jedes Feld 3x2 Flaechen -> 12 x 8 Unterfelder.
const SUB_X = 12, SUB_Y = 8;

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
    this.lastCell = null;
    this.stroking = false;
    this.syncTimer = null;
    this.encoding = false;
    this.pickNext = false;
    this.gen = 0;                 // Rundenzaehler: verspaetete PNGs der alten Runde verwerfen
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
    // Der Knopf kann nicht wissen, wohin man zeigt: naechster Klick ins Bild nimmt die Farbe.
    this.el.btnEye.onclick = () => { this.pickNext = true; this.el.hint.textContent = 'Jetzt auf Wand, Boden oder Objekt klicken.'; };
    input.onEyedrop = () => this.eyedrop();
    // Tarnanzeige: wie gut passt die Koerperfarbe zur naechsten Wand bzw. zum Boden?
    this.camoT = 0;
    this.el.camo = document.createElement('div');
    this.el.camo.className = 'camo-meter';
    this.el.camo.innerHTML = '<div class="camo-label">Tarnung <b>–</b></div><div class="camo-track" style="height:8px;border-radius:5px;background:rgba(0,0,0,.45);overflow:hidden;margin-top:4px"><div class="camo-fill" style="height:100%;width:0;border-radius:5px;transition:width .3s,background .3s"></div></div>';
    this.el.camo.style.cssText = 'font-size:12px;color:var(--muted,#94a3b8)';
    this.el.panel.insertBefore(this.el.camo, this.el.hint);
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

  /**
   * Tarnwert 0..1: Durchschnittsfarbe des Koerpers gegen die Flaeche, vor der man steht
   * (naechste Mauer im Umkreis von 2,5 m, sonst der Boden unter den Fuessen).
   */
  camouflage() {
    const me = this.renderer.me, map = this.renderer.map;
    if (!me || !map || !this.canvas) return null;
    const o = { x: me.position.x, y: me.position.z, h: 0.9 };
    let best = null;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const hit = raycast3D(map, o, { x: Math.cos(a), y: Math.sin(a), h: 0 }, 2.5);
      if (hit && hit.kind === 'wall' && (!best || hit.dist < best.dist)) best = hit;
    }
    const tx = Math.floor(o.x), ty = Math.floor(o.y);
    const surf = best ? surfaceColor(map, best) : surfaceColor(map, { kind: 'floor', tx, ty });
    return { match: colorMatch(this.average(), surf), wall: !!best };
  }

  updateCamo() {
    const c = this.camouflage();
    if (!c) return;
    const pct = Math.round(c.match * 100);
    const fill = this.el.camo.querySelector('.camo-fill');
    this.el.camo.querySelector('.camo-label').innerHTML = `Tarnung zur ${c.wall ? 'Wand' : 'Boden'}farbe <b>${pct} %</b>`;
    fill.style.width = pct + '%';
    fill.style.background = pct >= 80 ? '#7ee787' : pct >= 55 ? '#f0b429' : '#ff6b6b';
  }

  /** Pro Frame: Pinselstriche auf dem eigenen Koerper, Kameradrehung. */
  update(now) {
    if (!this.active || !this.renderer.me) return;
    if (now - this.camoT > 450) { this.camoT = now; this.updateCamo(); }
    const drag = this.input.takeDrag();
    if (drag.dx || drag.dy) {
      this.renderer.orbit.yaw += drag.dx * 0.006;
      this.renderer.orbit.pitch = clamp(this.renderer.orbit.pitch - drag.dy * 0.006, -0.6, 1.2);
    }
    if (this.pickNext && this.input.mouse.left) {
      this.pickNext = false;
      this.input.mouse.left = false;
      this.eyedrop();
      return;
    }
    if (this.input.mouse.left) {
      const hit = this.renderer.pickSelf(this.input.mouse.x, this.input.mouse.y);
      if (hit && hit.uv) {
        if (!this.stroking) { this.stroking = true; this.snapshot(); this.lastUV = null; }
        this.dab(hit.uv);
      } else this.lastUV = null;
      if (now - this.lastSync > 400) this.sync(false);
    } else if (this.stroking) {
      this.endStroke();
      this.sync(true);
    }
  }

  endStroke() { this.stroking = false; this.lastUV = null; this.lastCell = null; }

  /**
   * Einen Pinseltupfer setzen, bei durchgehendem Strich Zwischenpunkte fuellen.
   * Jede Flaeche eines Koerperteils ist ein eigenes Unterfeld im Atlas. Tupfer werden
   * darauf zugeschnitten und Striche nur innerhalb desselben Unterfelds verbunden -
   * sonst faerbt ein Strich ueber den Bauch auch Ruecken oder Kopf.
   */
  dab(uv) {
    const cv = this.canvas; if (!cv) return;
    const ctx = cv.getContext('2d');
    const c = this.finalColor();
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    const T = cv.width;
    const x = uv.x * T, y = (1 - uv.y) * T;
    const r = this.brush / 2;
    const cxI = Math.min(SUB_X - 1, Math.max(0, Math.floor(uv.x * SUB_X)));
    const cyI = Math.min(SUB_Y - 1, Math.max(0, Math.floor(uv.y * SUB_Y)));
    const cell = cxI + ',' + cyI;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cxI * T / SUB_X, T - (cyI + 1) * T / SUB_Y, T / SUB_X, T / SUB_Y);
    ctx.clip();
    const dot = (px, py) => { ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); };
    if (this.lastUV && this.lastCell === cell) {
      const lx = this.lastUV.x * T, ly = (1 - this.lastUV.y) * T;
      const d = Math.hypot(x - lx, y - ly);
      const n = Math.max(1, Math.ceil(d / (r * 0.5)));
      for (let i = 1; i <= n; i++) dot(lx + (x - lx) * (i / n), ly + (y - ly) * (i / n));
    } else dot(x, y);
    ctx.restore();
    this.lastUV = { x: uv.x, y: uv.y };
    this.lastCell = cell;
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

  /**
   * Textur an den Server schicken. Hoechstens etwa 3-mal pro Sekunde (der Server nimmt 4);
   * eine erzwungene Sendung, die zu frueh kommt, wird nachgeholt statt verworfen.
   * Das PNG entsteht asynchron (toBlob), damit das Malen nicht ruckelt.
   */
  sync(force) {
    if (!this.dirty || !this.canvas) return;
    const now = performance.now();
    const wait = (force ? 300 : 400) - (now - this.lastSync);
    if (wait > 0 || this.encoding) {
      if (force && !this.syncTimer) this.syncTimer = setTimeout(() => { this.syncTimer = null; this.sync(true); }, Math.max(wait, 60));
      return;
    }
    this.lastSync = now;
    this.dirty = false;
    this.encoding = true;
    const avg = this.average();
    const gen = this.gen;
    const send = (png) => {
      this.encoding = false;
      if (!png || gen !== this.gen) return;     // Runde inzwischen neu gestartet: alte Bemalung verwerfen
      if (png.length > C.PAINT_MAX_BYTES) { this.el.hint.textContent = 'Bemalung zu detailliert für den Versand – etwas vereinfachen.'; return; }
      this.net?.send({ t: 'paint', paint: { png }, avg });
    };
    const cv = this.canvas;
    if (!cv.toBlob) { send(cv.toDataURL('image/png')); return; }
    cv.toBlob((blob) => {
      if (!blob) { send(null); return; }
      const fr = new FileReader();
      fr.onload = () => send(String(fr.result));
      fr.onerror = () => send(null);
      fr.readAsDataURL(blob);
    }, 'image/png');
  }

  /** Bei Rundenstart: alles zuruecksetzen. */
  reset() {
    clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.pickNext = false;
    this.gen++;
    this.encoding = false;
    this.undo = [];
    this.endStroke();
    this.dirty = false;
    if (this.active) this.setActive(false);
  }
}
