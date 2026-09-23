// Baut die Arena aus der Karte: Boden, farbige Mauern, Buesche, Wasser, Saeulen,
// dazu Landschaft ausserhalb der Mauer (Wiese, Baeume) und Laternen.
// Stellt ausserdem die Farb-Pipette bereit: Welche Farbe hat die Oberflaeche,
// die der Strahl getroffen hat? Genau die nimmt man sich zum Anmalen.
//
// Wichtig fuer die Tarnung: Alle Muster (Fugen, Steine, Dielen, Rauschen) sind
// Helligkeitsmasken mit Mittelwert 1. Die Durchschnittsfarbe jeder Flaeche bleibt
// damit exakt die Grundfarbe aus shared/map.js (tileColorAt / wallColorAt), die
// auch Pipette, Server und Bots verwenden.

import * as THREE from 'three';
import * as C from '/shared/constants.js';
import { idx, makeRng, wallColorAt } from '/shared/map.js';
import { tileHeight } from '/shared/physics.js';
import { pillarGeometries, PILLAR_COLOR, rgb } from './models.js';

const PX = 32;          // Texturpixel je Bodenkachel
const WALL_PX = 64;     // Texturpixel je Meter an der Mauer
const WALL_TW = 4;      // Mauertextur wiederholt sich alle 4 m (weniger sichtbare Wiederholung)

// ---------------------------------------------------------------- Rauschen
/** Kachelbares Werte-Rauschen auf einem cells x cells-Gitter, u/v periodisch in [0,1). */
function makeNoise(rng, cells) {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const at = (a, b) => g[(((b % cells) + cells) % cells) * cells + (((a % cells) + cells) % cells)];
  return (u, v) => {
    const x = u * cells, y = v * cells;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

/** Normiert eine Maske auf Mittelwert 1 (damit bleibt die Flaechenfarbe im Mittel gleich). */
function normalize(m) {
  let s = 0;
  for (let i = 0; i < m.length; i++) s += m[i];
  const k = m.length / s;
  for (let i = 0; i < m.length; i++) m[i] *= k;
  return m;
}

// ---------------------------------------------------------------- Bodenmuster
// Reihen-Muster: jede Reihe hat eine Hoehe, einen Versatz und Steinbreiten (Summe = PX).
const ROWS = {
  platten: [{ h: 16, off: 0, w: [16, 16] }, { h: 16, off: 0, w: [16, 16] }],
  grossplatte: [{ h: 32, off: 0, w: [32] }],
  ziegel: [0, 8, 0, 8].map((off) => ({ h: 8, off, w: [16, 16] })),
  mosaik: [0, 0, 0, 0].map((off) => ({ h: 8, off, w: [8, 8, 8, 8] })),
  schiefer: [{ h: 10, off: 0, w: [13, 19] }, { h: 12, off: 7, w: [18, 14] }, { h: 10, off: 3, w: [10, 12, 10] }],
  dielen: [0, 20, 9, 27].map((off) => ({ h: 8, off, w: [32] })),
};

/** Welche Musterart welche Zonenfarbe bekommt (Index wie C.PALETTE). */
const ZONE_PATTERN = ['kopfstein', 'platten', 'schiefer', 'ziegel', 'mosaik', 'raute', 'dielen', 'grossplatte'];

/**
 * Erzeugt eine Kachelmaske (PX x PX): Farbfaktor (Mittel 1) und Hoehe (0 = Fuge, 1 = Oberflaeche).
 */
function makePattern(kind, rng) {
  const col = new Float32Array(PX * PX), hgt = new Float32Array(PX * PX);
  const noise = makeNoise(rng, 8), fine = makeNoise(rng, 16);
  const cellRand = Array.from({ length: 64 }, () => rng() - 0.5);
  const put = (x, y, c, h) => { col[y * PX + x] = c; hgt[y * PX + x] = h; };

  if (ROWS[kind]) {
    const rows = ROWS[kind];
    const contrast = kind === 'dielen' ? 0.1 : kind === 'mosaik' ? 0.12 : 0.07;
    let y0 = 0;
    rows.forEach((row, ri) => {
      for (let ly = 0; ly < row.h; ly++) {
        const y = y0 + ly;
        for (let x = 0; x < PX; x++) {
          const xx = (x + row.off) % PX;
          let ci = 0, start = 0;
          while (ci < row.w.length - 1 && xx >= start + row.w[ci]) { start += row.w[ci]; ci++; }
          const lx = xx - start, w = row.w[ci];
          const id = (ri * 7 + ci * 3) % cellRand.length;
          const n = noise(x / PX, y / PX) - 0.5, f = fine(x / PX, y / PX) - 0.5;
          let c = 1 + cellRand[id] * contrast * 2 + n * 0.06 + f * 0.05;
          let h = 0.85 + n * 0.2;
          if (kind === 'dielen') c += Math.sin((y * 2.1 + n * 9) * 1.3) * 0.03 + f * 0.04;   // Holzmaserung
          if (lx === 0 || ly === 0) { c = 0.66; h = 0; }                                   // Fuge
          else if (lx === 1 || ly === 1) { c += 0.06; h = 0.7; }                           // Lichtkante
          else if (lx === w - 1 || ly === row.h - 1) { c -= 0.06; h = 0.7; }               // Schattenkante
          put(x, y, c, h);
        }
      }
      y0 += row.h;
    });
  } else if (kind === 'kopfstein' || kind === 'kiesel') {
    // Voronoi-Pflaster, kachelbar durch Wiederholung der Saatpunkte in den Nachbarkacheln
    const n = kind === 'kopfstein' ? 7 : 11;
    const pts = Array.from({ length: n }, () => [rng() * PX, rng() * PX, rng() - 0.5]);
    for (let y = 0; y < PX; y++) {
      for (let x = 0; x < PX; x++) {
        let d1 = Infinity, d2 = Infinity, best = 0;
        for (let i = 0; i < n; i++) {
          for (let oy = -PX; oy <= PX; oy += PX) {
            for (let ox = -PX; ox <= PX; ox += PX) {
              const d = Math.hypot(pts[i][0] + ox - x, pts[i][1] + oy - y);
              if (d < d1) { d2 = d1; d1 = d; best = i; } else if (d < d2) d2 = d;
            }
          }
        }
        const edge = d2 - d1;   // Abstand zur Fuge
        const f = fine(x / PX, y / PX) - 0.5;
        if (edge < 1.3) put(x, y, 0.62, 0);
        else {
          const round = Math.min(1, edge / 5);   // gewoelbte Steine: Rand etwas dunkler
          put(x, y, 0.9 + round * 0.14 + pts[best][2] * 0.12 + f * 0.06, 0.4 + round * 0.6);
        }
      }
    }
  } else if (kind === 'raute') {
    for (let y = 0; y < PX; y++) {
      for (let x = 0; x < PX; x++) {
        const a = (x + y) % 16, b = (x - y + PX * 2) % 16;
        const alt = (((x + y) >> 4) + ((x - y + PX * 2) >> 4)) & 1;
        const f = fine(x / PX, y / PX) - 0.5;
        if (a === 0 || b === 0) put(x, y, 0.68, 0);
        else put(x, y, (alt ? 1.07 : 0.95) + f * 0.05 + (a === 1 || b === 1 ? 0.05 : 0), a === 1 || b === 1 ? 0.7 : 1);
      }
    }
  } else if (kind === 'erde') {
    // Unter Bueschen: Erde mit Laubflecken
    for (let y = 0; y < PX; y++) {
      for (let x = 0; x < PX; x++) {
        const n = noise(x / PX, y / PX), f = fine(x / PX, y / PX);
        put(x, y, 0.85 + n * 0.3 + (f > 0.72 ? 0.12 : 0) - (f < 0.22 ? 0.1 : 0), n);
      }
    }
  } else {
    for (let i = 0; i < col.length; i++) { col[i] = 1; hgt[i] = 1; }
  }
  return { col: normalize(col), hgt };
}

function makeFloorTextures(map) {
  const W = map.w * PX, H = map.h * PX;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const bump = document.createElement('canvas');
  bump.width = W; bump.height = H;
  const ctx = cv.getContext('2d'), bctx = bump.getContext('2d');
  const img = ctx.createImageData(W, H), bimg = bctx.createImageData(W, H);
  const rng = makeRng(map.seed ^ 0x5bd1e995);
  const patterns = {};
  const pat = (kind) => (patterns[kind] ??= makePattern(kind, makeRng((map.seed ^ kind.length * 0x9e37) + kind.charCodeAt(0) * 7919)));
  const colors = new Array(map.w * map.h);
  for (let ty = 0; ty < map.h; ty++) {
    for (let tx = 0; tx < map.w; tx++) {
      const i = idx(tx, ty);
      const t = map.tiles[i];
      let c, kind;
      if (t === C.T_WALL || t === C.T_PILLAR) { c = C.WALL_COLOR; kind = 'glatt'; }
      else if (t === C.T_BUSH) { c = C.BUSH_COLOR; kind = 'erde'; }            // wie tileColorAt auf dem Server
      else if (t === C.T_WATER) { c = C.WATER_COLOR; kind = 'kiesel'; }
      else { c = C.PALETTE[map.colors[i]] ?? C.PALETTE[0]; kind = ZONE_PATTERN[map.colors[i]] ?? 'platten'; }
      colors[i] = c;
      const p = pat(kind);
      const v = 1 + (rng() - 0.5) * 0.05;   // leichte Streuung je Kachel
      for (let py = 0; py < PX; py++) {
        // Canvas-Zeile 0 = Kartenzeile ty = 0 (Textur wird beim Hochladen gespiegelt, Ebene ist gedreht)
        const row = (ty * PX + py) * W + tx * PX;
        for (let px = 0; px < PX; px++) {
          const m = p.col[py * PX + px] * v;
          const o = (row + px) * 4;
          img.data[o] = Math.min(255, c[0] * m);
          img.data[o + 1] = Math.min(255, c[1] * m);
          img.data[o + 2] = Math.min(255, c[2] * m);
          img.data[o + 3] = 255;
          const h = p.hgt[py * PX + px] * 255;
          bimg.data[o] = h; bimg.data[o + 1] = h; bimg.data[o + 2] = h; bimg.data[o + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  bctx.putImageData(bimg, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const btex = new THREE.CanvasTexture(bump);
  btex.colorSpace = THREE.NoColorSpace;
  btex.anisotropy = 8;
  return { tex, btex, colors };
}

// ---------------------------------------------------------------- Mauern
/**
 * Mauertextur fuer eine Mauerhoehe h (m): Sockel, Quadersteine mit Fugen, Abdeckplatte.
 * Rueckgabe: Textur (lineare Faktoren) und Ausgleichsfaktor, damit das Mittel wieder 1 ergibt.
 */
function makeWallTexture(h, seed) {
  const W = WALL_TW * WALL_PX, H = Math.round(h * WALL_PX);
  const rng = makeRng(seed);
  const noise = makeNoise(rng, 16), fine = makeNoise(rng, 64);
  const m = new Float32Array(W * H);
  const px = (meters) => Math.round(meters * WALL_PX);
  const sockel = px(0.2), cope = px(0.13);
  const courses = Math.max(1, Math.round((H - sockel - cope) / px(0.32)));
  const courseH = (H - sockel - cope) / courses;
  const blockW = px(0.5);
  const rand = Array.from({ length: 512 }, () => rng() - 0.5);
  for (let y = 0; y < H; y++) {
    const fromBottom = H - 1 - y;
    for (let x = 0; x < W; x++) {
      const n = noise(x / W, y / H) - 0.5, f = fine(x / W, y / H) - 0.5;
      let c;
      if (y < cope) {
        // Abdeckplatte oben, mit Schattenfuge darunter
        c = y >= cope - 2 ? 0.62 : y < 2 ? 1.12 : 1.06 + n * 0.08 + f * 0.05;
      } else if (fromBottom < sockel) {
        // Sockelleiste unten: dunkler, mit heller Oberkante
        c = fromBottom >= sockel - 2 ? 1.02 : fromBottom >= sockel - 4 ? 0.6 : 0.68 + n * 0.08 + f * 0.04;
      } else {
        const yy = y - cope;
        const course = Math.floor(yy / courseH);
        const ly = yy - course * courseH;
        const off = (course & 1) ? blockW / 2 : 0;
        const xx = (x + off) % W;
        const bi = Math.floor(xx / blockW), lx = xx - bi * blockW;
        const id = (course * 17 + bi * 5) % rand.length;
        if (ly < 2 || lx < 2) c = 0.64;                                   // Fuge
        else {
          c = 1 + rand[id] * 0.1 + n * 0.08 + f * 0.06;
          if (ly < 4) c += 0.07;                                          // Lichtkante oben
          else if (ly > courseH - 3) c -= 0.07;                           // Schattenkante unten
          if (lx < 4) c += 0.03; else if (lx > blockW - 3) c -= 0.04;
        }
      }
      m[y * W + x] = c;
    }
  }
  normalize(m);
  let max = 0;
  for (let i = 0; i < m.length; i++) max = Math.max(max, m[i]);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < m.length; i++) {
    const v = Math.round((m[i] / max) * 255);
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;        // Werte sind Helligkeitsfaktoren, keine Farben
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return { tex, gain: max, copeV: [1 - (cope - 3) / H, 1 - 3 / H] };
}

/**
 * Alle Mauerkacheln einer Hoehe als EIN Mesh. Verdeckte Seiten zwischen Nachbarmauern
 * entfallen; UVs laufen in Weltkoordinaten, damit das Mauerwerk ueber Kacheln durchlaeuft.
 * userData.faceTile: Dreieck -> Kachelindex (fuer die Pipette).
 */
function buildWallMesh(map, h, wt) {
  const pos = [], nor = [], uv = [], col = [], index = [], faceTile = [];
  const tmp = new THREE.Color();
  const quad = (p, n, uvs, c, tile) => {
    const b = pos.length / 3;
    // Wicklung so waehlen, dass die Vorderseite zur Normalen zeigt
    const ax = p[1][0] - p[0][0], ay = p[1][1] - p[0][1], az = p[1][2] - p[0][2];
    const bx = p[2][0] - p[0][0], by = p[2][1] - p[0][1], bz = p[2][2] - p[0][2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
    for (let k = 0; k < 4; k++) { pos.push(...p[k]); nor.push(...n); uv.push(...uvs[k]); col.push(c.r, c.g, c.b); }
    if (flip) index.push(b, b + 2, b + 1, b, b + 3, b + 2); else index.push(b, b + 1, b + 2, b, b + 2, b + 3);
    faceTile.push(tile, tile);
  };
  const solidH = (tx, ty) => {
    if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return Infinity;
    return map.tiles[idx(tx, ty)] === C.T_WALL ? tileHeight(map, tx, ty) : 0;
  };
  const [cv0, cv1] = wt.copeV;
  for (let ty = 0; ty < map.h; ty++) {
    for (let tx = 0; tx < map.w; tx++) {
      const i = idx(tx, ty);
      if (map.tiles[i] !== C.T_WALL || tileHeight(map, tx, ty) !== h) continue;
      tmp.copy(rgb(wallColorAt(map, tx, ty))).multiplyScalar(wt.gain);
      const x0 = tx, x1 = tx + 1, z0 = ty, z1 = ty + 1;
      const U = (m) => m / WALL_TW;
      // Deckflaeche: Abdeckplatten-Streifen der Textur
      quad([[x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1]], [0, 1, 0],
        [[U(x0), cv0 + (cv1 - cv0) * 0.1], [U(x1), cv0 + (cv1 - cv0) * 0.1], [U(x1), cv1], [U(x0), cv1]], tmp, i);
      // Seiten nur, wenn der Nachbar niedriger ist (sonst unsichtbar)
      if (solidH(tx + 1, ty) < h) quad([[x1, 0, z0], [x1, 0, z1], [x1, h, z1], [x1, h, z0]], [1, 0, 0], [[U(z0), 0], [U(z1), 0], [U(z1), 1], [U(z0), 1]], tmp, i);
      if (solidH(tx - 1, ty) < h) quad([[x0, 0, z1], [x0, 0, z0], [x0, h, z0], [x0, h, z1]], [-1, 0, 0], [[U(z1), 0], [U(z0), 0], [U(z0), 1], [U(z1), 1]], tmp, i);
      if (solidH(tx, ty + 1) < h) quad([[x1, 0, z1], [x0, 0, z1], [x0, h, z1], [x1, h, z1]], [0, 0, 1], [[U(x1), 0], [U(x0), 0], [U(x0), 1], [U(x1), 1]], tmp, i);
      if (solidH(tx, ty - 1) < h) quad([[x0, 0, z0], [x1, 0, z0], [x1, h, z0], [x0, h, z0]], [0, 0, -1], [[U(x0), 0], [U(x1), 0], [U(x1), 1], [U(x0), 1]], tmp, i);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ map: wt.tex, bumpMap: wt.tex, bumpScale: 1.2, vertexColors: true, roughness: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.kind = 'wall';
  mesh.userData.faceTile = faceTile;
  return mesh;
}

// ---------------------------------------------------------------- Wasser
/** Kachelbare Wellen-Normalenkarte. */
function makeWaterNormals(seed) {
  const S = 256;
  const rng = makeRng(seed);
  const n1 = makeNoise(rng, 8), n2 = makeNoise(rng, 16);
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      hgt[y * S + x] = Math.sin((u * 3 + v * 2) * Math.PI * 2 + n1(u, v) * 5) * 0.5
        + Math.sin((u * -2 + v * 5) * Math.PI * 2 + n2(u, v) * 4) * 0.3 + n2(u, v) * 0.6;
    }
  }
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(S, S);
  const H = (x, y) => hgt[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (H(x - 1, y) - H(x + 1, y)) * 2.2, dy = (H(x, y - 1) - H(x, y + 1)) * 2.2;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * S + x) * 4;
      img.data[o] = (dx / l * 0.5 + 0.5) * 255;
      img.data[o + 1] = (dy / l * 0.5 + 0.5) * 255;
      img.data[o + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Kleine Himmels-Umgebung (equirektangular) fuer Spiegelungen auf dem Wasser. */
function makeSkyEnv() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 64;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, '#5f97d6'); g.addColorStop(0.45, '#bcd6ef'); g.addColorStop(0.5, '#e8eef2');
  g.addColorStop(0.53, '#7d8f6a'); g.addColorStop(1, '#4b5a40');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildWater(map, waterIdx) {
  const pos = [], uv = [], index = [];
  const fpos = [], fcol = [], findex = [];
  const Y = 0.035;
  const isWater = (tx, ty) => tx >= 0 && ty >= 0 && tx < map.w && ty < map.h && map.tiles[idx(tx, ty)] === C.T_WATER;
  for (const i of waterIdx) {
    const tx = i % map.w, ty = (i / map.w) | 0;
    const b = pos.length / 3;
    pos.push(tx, Y, ty, tx + 1, Y, ty, tx + 1, Y, ty + 1, tx, Y, ty + 1);
    uv.push(tx / 3, ty / 3, (tx + 1) / 3, ty / 3, (tx + 1) / 3, (ty + 1) / 3, tx / 3, (ty + 1) / 3);
    index.push(b, b + 2, b + 1, b, b + 3, b + 2);
    // Uferschaum: schmaler Streifen an Kanten zu Land, aussen deckend, innen transparent
    const edges = [
      [!isWater(tx, ty - 1), [tx, ty], [tx + 1, ty], [0, 1]],
      [!isWater(tx, ty + 1), [tx + 1, ty + 1], [tx, ty + 1], [0, -1]],
      [!isWater(tx - 1, ty), [tx, ty + 1], [tx, ty], [1, 0]],
      [!isWater(tx + 1, ty), [tx + 1, ty], [tx + 1, ty + 1], [-1, 0]],
    ];
    for (const [shore, a, c, inward] of edges) {
      if (!shore) continue;
      const w = 0.16, fb = fpos.length / 3, y = Y + 0.004;
      fpos.push(a[0], y, a[1], c[0], y, c[1], c[0] + inward[0] * w, y, c[1] + inward[1] * w, a[0] + inward[0] * w, y, a[1] + inward[1] * w);
      fcol.push(1, 1, 1, 0.75, 1, 1, 1, 0.75, 1, 1, 1, 0, 1, 1, 1, 0);
      findex.push(fb, fb + 2, fb + 1, fb, fb + 3, fb + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const normalMap = makeWaterNormals(map.seed ^ 0x2545f491);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x1d4f73, transparent: true, opacity: 0.7, roughness: 0.1, metalness: 0.0,
    normalMap, normalScale: new THREE.Vector2(0.7, 0.7), envMap: makeSkyEnv(), envMapIntensity: 0.35, depthWrite: false,
  });
  const water = new THREE.Mesh(geo, waterMat);
  water.userData.kind = 'water';
  water.renderOrder = 1;

  const fgeo = new THREE.BufferGeometry();
  fgeo.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
  fgeo.setAttribute('color', new THREE.Float32BufferAttribute(fcol, 4));
  fgeo.setIndex(findex);
  const foamMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false });
  const foam = new THREE.Mesh(fgeo, foamMat);
  foam.renderOrder = 2;
  return { water, waterMat, foam, foamMat };
}

// ---------------------------------------------------------------- Buesche
/** Klumpige Blattkugel (facettiert) mit dunklerer Unterseite als Vertexfarbe. */
function makeBushGeometry(seed) {
  const geo = new THREE.IcosahedronGeometry(0.52, 1);
  const rng = makeRng(seed);
  const pos = geo.attributes.position;
  const disp = new Map();
  const colors = new Float32Array(pos.count * 3);
  let sum = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    if (!disp.has(key)) disp.set(key, 0.84 + rng() * 0.3);
    const d = disp.get(key);
    pos.setXYZ(i, x * d, y * d * 0.92, z * d);
    const ao = 0.72 + 0.36 * THREE.MathUtils.smoothstep(y, -0.5, 0.45);
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = ao;
    sum += ao;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return { geo, aoMean: sum / pos.count };
}

// ---------------------------------------------------------------- Umgebung
/** Wiese und Baeume ausserhalb der Arena (nur Kulisse, nicht anklickbar, ohne Schatten). */
function buildScenery(group, map, rng) {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(420, 420),
    new THREE.MeshStandardMaterial({ color: 0x5f7d4c, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(map.w / 2, -0.03, map.h / 2);
  group.add(ground);

  const trunkGeo = new THREE.CylinderGeometry(0.13, 0.22, 1.8, 6);
  trunkGeo.translate(0, 0.9, 0);
  const pineParts = [[1.35, 2.3, 2.1], [1.05, 2.0, 3.2], [0.7, 1.6, 4.2]].map(([r, hh, y]) => {
    const g = new THREE.ConeGeometry(r, hh, 8);
    g.translate(0, y, 0);
    return g.toNonIndexed();
  });
  const pineGeo = mergeFlat(pineParts);
  const roundGeo = new THREE.IcosahedronGeometry(1.5, 1);
  const rp = roundGeo.attributes.position;
  const rr = makeRng(map.seed ^ 0x1234567);
  const seen = new Map();
  for (let i = 0; i < rp.count; i++) {
    const key = `${rp.getX(i).toFixed(3)},${rp.getY(i).toFixed(3)},${rp.getZ(i).toFixed(3)}`;
    if (!seen.has(key)) seen.set(key, 0.85 + rr() * 0.3);
    const d = seen.get(key);
    rp.setXYZ(i, rp.getX(i) * d, rp.getY(i) * d * 0.85 + 3.0, rp.getZ(i) * d);
  }
  roundGeo.computeVertexNormals();

  const spots = [];
  for (let n = 0; n < 5000 && spots.length < 230; n++) {
    const x = -34 + rng() * (map.w + 68), z = -34 + rng() * (map.h + 68);
    const out = Math.max(-x, x - map.w, -z, z - map.h);   // Abstand ausserhalb der Mauer
    if (out < 1.6) continue;
    if (rng() > 1.15 - out / 30) continue;                  // nahe der Mauer dichter
    if (spots.some((s) => (s.x - x) ** 2 + (s.z - z) ** 2 < 5)) continue;
    spots.push({ x, z, s: 0.85 + rng() * 0.9, pine: rng() < 0.55, rot: rng() * Math.PI * 2 });
  }
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4f3a, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
  const pines = new THREE.InstancedMesh(pineGeo, leafMat, spots.filter((s) => s.pine).length);
  const rounds = new THREE.InstancedMesh(roundGeo, leafMat, spots.filter((s) => !s.pine).length);
  // Reine Kulisse: im Leistungsmodus ausgeblendet (viele Dreiecke).
  trunks.userData.decor = pines.userData.decor = rounds.userData.decor = true;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const col = new THREE.Color();
  let np = 0, nr = 0;
  spots.forEach((s, n) => {
    q.setFromEuler(e.set(0, s.rot, 0));
    p.set(s.x, 0, s.z);
    sc.setScalar(s.s);
    m4.compose(p, q, sc);
    trunks.setMatrixAt(n, m4);
    if (s.pine) {
      pines.setMatrixAt(np, m4);
      pines.setColorAt(np++, col.setHSL(0.33 + rng() * 0.05, 0.35, 0.2 + rng() * 0.07, THREE.SRGBColorSpace));
    } else {
      rounds.setMatrixAt(nr, m4);
      const autumn = rng() < 0.12;
      rounds.setColorAt(nr++, autumn ? col.setHSL(0.08 + rng() * 0.04, 0.6, 0.42, THREE.SRGBColorSpace)
        : col.setHSL(0.24 + rng() * 0.07, 0.42, 0.3 + rng() * 0.08, THREE.SRGBColorSpace));
    }
  });
  group.add(trunks, pines, rounds);
}

/** Nicht-indizierte Geometrien (nur position) zusammenfuegen und Normalen neu berechnen. */
function mergeFlat(list) {
  const total = list.reduce((s, g) => s + g.attributes.position.array.length, 0);
  const arr = new Float32Array(total);
  let o = 0;
  for (const g of list) { arr.set(g.attributes.position.array, o); o += g.attributes.position.array.length; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Laternen an der Innenseite der Aussenmauer (reines Dekor, hoch ueber Kopfhoehe). */
function buildLamps(group, map) {
  const spots = [];
  const H = C.WALL_H_EDGE - 0.75;
  const free = (tx, ty) => tx >= 0 && ty >= 0 && tx < map.w && ty < map.h && !C.SOLID_TILES.has(map.tiles[idx(tx, ty)]);
  for (let tx = 4; tx < map.w - 4; tx += 6) {
    if (free(tx, 2)) spots.push({ x: tx + 0.5, z: 2, ry: 0 });
    if (free(tx, map.h - 3)) spots.push({ x: tx + 0.5, z: map.h - 2, ry: Math.PI });
  }
  for (let ty = 5; ty < map.h - 4; ty += 6) {
    if (free(2, ty)) spots.push({ x: 2, z: ty + 0.5, ry: -Math.PI / 2 });
    if (free(map.w - 3, ty)) spots.push({ x: map.w - 2, z: ty + 0.5, ry: Math.PI / 2 });
  }
  const arm = new THREE.BoxGeometry(0.06, 0.06, 0.3); arm.translate(0, 0.16, 0.15);
  const plate = new THREE.BoxGeometry(0.14, 0.26, 0.03); plate.translate(0, 0.1, 0.015);
  const cap = new THREE.ConeGeometry(0.14, 0.12, 4); cap.rotateY(Math.PI / 4); cap.translate(0, 0.2, 0.3);
  const metalGeo = mergeFlat([arm.toNonIndexed(), plate.toNonIndexed(), cap.toNonIndexed()]);
  const glassGeo = new THREE.BoxGeometry(0.14, 0.2, 0.14); glassGeo.translate(0, 0.04, 0.3);
  const metal = new THREE.InstancedMesh(metalGeo, new THREE.MeshStandardMaterial({ color: 0x23262d, metalness: 0.6, roughness: 0.45 }), spots.length);
  const glass = new THREE.InstancedMesh(glassGeo, new THREE.MeshStandardMaterial({ color: 0xffe2b0, emissive: 0xffc070, emissiveIntensity: 1.5, roughness: 0.3 }), spots.length);
  const m4 = new THREE.Matrix4();
  spots.forEach((s, n) => {
    m4.makeRotationY(s.ry);
    m4.setPosition(s.x, H, s.z);
    metal.setMatrixAt(n, m4);
    glass.setMatrixAt(n, m4);
  });
  group.add(metal, glass);
}

// ---------------------------------------------------------------- Himmel
/**
 * Himmelskuppel mit Verlauf, Sonnenschein und weichen Wolken. Der Horizont hat genau
 * die Nebelfarbe der Szene, damit entfernte Baeume nahtlos im Dunst verschwinden.
 */
function makeSkyDome(map, fogColor) {
  const geo = new THREE.SphereGeometry(100, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      horizon: { value: new THREE.Color(fogColor) },
      zenith: { value: new THREE.Color(0x3f7fcf) },
      ground: { value: new THREE.Color(0x6f8a62) },
      sunDir: { value: new THREE.Vector3(14, 16, 9).normalize() },
      time: { value: 0 },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;   // immer ganz hinten
      }`,
    fragmentShader: `
      uniform vec3 horizon; uniform vec3 zenith; uniform vec3 ground; uniform vec3 sunDir; uniform float time;
      varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.55));
        col = mix(col, ground, smoothstep(0.0, -0.08, h));
        // weiche Wolken: zwei Rausch-Oktaven auf eine Ebene ueber dem Betrachter projiziert
        if (h > 0.02) {
          vec2 uv = d.xz / (h + 0.18) * 1.6 + vec2(time * 0.004, time * 0.002);
          float n = noise(uv) * 0.6 + noise(uv * 2.3 + 7.1) * 0.3 + noise(uv * 5.1 + 3.3) * 0.1;
          float c = smoothstep(0.52, 0.8, n) * smoothstep(0.02, 0.25, h);
          col = mix(col, vec3(1.0), c * 0.7);
        }
        float s = max(dot(d, normalize(sunDir)), 0.0);
        col += vec3(1.0, 0.92, 0.75) * (pow(s, 600.0) * 1.2 + pow(s, 12.0) * 0.18);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.position.set(map.w / 2, 0, map.h / 2);
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  dome.userData.kind = 'sky';
  return dome;
}

/** Gibt alle GPU-Ressourcen einer Welt frei (fuer Kartenwechsel in render.js). */
export function disposeWorld(world) {
  if (!world) return;
  const seen = new Set();
  world.group.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (seen.has(m)) continue;
      seen.add(m);
      for (const key of ['map', 'bumpMap', 'normalMap', 'envMap']) if (m[key] && !seen.has(m[key])) { seen.add(m[key]); m[key].dispose(); }
      m.dispose();
    }
    if (o.isInstancedMesh) o.dispose();
  });
}

// ---------------------------------------------------------------- Aufbau
export function buildWorld(scene, map) {
  const group = new THREE.Group();
  const rng = makeRng(map.seed ^ 0x9e3779b9);
  const { tex, btex, colors } = makeFloorTextures(map);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(map.w, map.h),
    new THREE.MeshStandardMaterial({ map: tex, bumpMap: btex, bumpScale: 1.5, roughness: 0.92, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(map.w / 2, 0, map.h / 2);
  floor.receiveShadow = true;
  floor.userData.kind = 'floor';
  group.add(floor);

  const bushIdx = [], waterIdx = [];
  for (let i = 0; i < map.tiles.length; i++) {
    const t = map.tiles[i];
    if (t === C.T_BUSH) bushIdx.push(i);
    else if (t === C.T_WATER) waterIdx.push(i);
  }
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();

  // Mauern: Zonenfarbe (wallColorAt), damit man sich davor tarnen kann. Je Hoehe ein Mesh.
  const wallColors = new Array(map.w * map.h);
  for (let i = 0; i < map.tiles.length; i++) {
    if (map.tiles[i] === C.T_WALL) wallColors[i] = wallColorAt(map, i % map.w, (i / map.w) | 0);
  }
  const wallMeshes = [C.WALL_H_INNER, C.WALL_H_EDGE].map((h, k) => buildWallMesh(map, h, makeWallTexture(h, map.seed * 31 + k)));
  for (const w of wallMeshes) group.add(w);

  // Buesche: dichte, klumpige Blattkugeln, man kann hineinlaufen
  const { geo: bushGeo, aoMean } = makeBushGeometry(map.seed ^ 0x51ed27);
  const bushMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, flatShading: true, vertexColors: true });
  const LUMPS = 3;
  const bushes = new THREE.InstancedMesh(bushGeo, bushMat, bushIdx.length * LUMPS);
  const bushBase = rgb(C.BUSH_COLOR);
  const bushColors = [];
  const flowers = [];
  let bn = 0;
  const q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const srgb = { r: 0, g: 0, b: 0 };
  for (const i of bushIdx) {
    const tx = i % map.w, ty = (i / map.w) | 0;
    for (let k = 0; k < LUMPS; k++) {
      e.set(rng() * 0.6, rng() * Math.PI * 2, rng() * 0.6);
      q.setFromEuler(e);
      const sc = k === 0 ? 0.8 + rng() * 0.35 : 0.55 + rng() * 0.35;
      s.set(sc, sc * (0.8 + rng() * 0.15), sc);
      p.set(tx + 0.2 + rng() * 0.6, 0.3 * sc, ty + 0.2 + rng() * 0.6);
      m4.compose(p, q, s);
      bushes.setMatrixAt(bn, m4);
      col.copy(bushBase).offsetHSL((rng() - 0.5) * 0.04, 0, (rng() - 0.5) * 0.05);
      // Pipette liefert die Grundfarbe in sRGB (wie C.BUSH_COLOR), gerendert wird mit AO-Ausgleich
      col.getRGB(srgb, THREE.SRGBColorSpace);
      bushColors.push([Math.round(srgb.r * 255), Math.round(srgb.g * 255), Math.round(srgb.b * 255)]);
      bushes.setColorAt(bn, col.multiplyScalar(1 / aoMean));
      if (k === 0 && rng() < 0.3) {
        const n = 3 + ((rng() * 4) | 0);
        const fc = [0xf2d45c, 0xe58fb4, 0xb9a3f0, 0xf0a868][(rng() * 4) | 0];
        for (let f = 0; f < n; f++) {
          const a = rng() * Math.PI * 2, r = 0.2 + rng() * 0.22;
          flowers.push({ x: p.x + Math.cos(a) * r * sc, y: p.y + (0.3 + rng() * 0.12) * sc, z: p.z + Math.sin(a) * r * sc, c: fc });
        }
      }
      bn++;
    }
  }
  bushes.castShadow = true;
  bushes.receiveShadow = true;
  bushes.userData.kind = 'bush';
  group.add(bushes);
  if (flowers.length) {
    const fl = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.04, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }), flowers.length);
    flowers.forEach((f, n) => { m4.makeScale(1, 0.55, 1).setPosition(f.x, f.y, f.z); fl.setMatrixAt(n, m4); fl.setColorAt(n, col.set(f.c)); });
    fl.userData.decor = true;
    group.add(fl);
  }

  const { water, waterMat, foam, foamMat } = buildWater(map, waterIdx);
  group.add(water, foam);

  // Saeulen (Anker fuer den Zungenhaken): drei Instanz-Meshes statt vieler Einzelobjekte
  const pg = pillarGeometries();
  const stone = new THREE.MeshStandardMaterial({ color: rgb(PILLAR_COLOR), roughness: 0.78, metalness: 0.05 });
  const pillars = ['base', 'shaft', 'cap'].map((key) => {
    const im = new THREE.InstancedMesh(pg[key], stone, Math.max(1, map.anchors.length));
    im.count = map.anchors.length;
    map.anchors.forEach((a, n) => { m4.makeTranslation(a.x / C.TILE, 0, a.y / C.TILE); im.setMatrixAt(n, m4); });
    im.castShadow = true; im.receiveShadow = true;
    im.userData.kind = 'pillar';
    group.add(im);
    return im;
  });

  buildScenery(group, map, makeRng(map.seed ^ 0x7f4a7c15));
  buildLamps(group, map);
  const sky = makeSkyDome(map, scene.fog?.color ?? 0x9fc3e6);
  group.add(sky);

  scene.add(group);
  return {
    group, floor, walls: wallMeshes[0], wallMeshes, bushes, water, waterMat, foamMat, pillars, sky,
    floorColors: colors, wallColors, bushColors, map,
    pickables: [floor, ...wallMeshes, bushes, ...pillars],
  };
}

/**
 * Farb-Pipette: Farbe der Oberflaeche an einem Raycast-Treffer (three.js-Intersection).
 * @returns {number[]|null} [r,g,b]
 */
export function sampleWorldColor(world, hit) {
  if (!hit) return null;
  const o = hit.object;
  const kind = o.userData.kind;
  if (kind === 'floor') {
    const tx = Math.floor(hit.point.x), ty = Math.floor(hit.point.z);
    if (tx < 0 || ty < 0 || tx >= world.map.w || ty >= world.map.h) return null;
    const i = idx(tx, ty);
    return world.floorColors[i] ? world.floorColors[i].slice() : null;
  }
  if (kind === 'wall') {
    const tile = o.userData.faceTile?.[hit.faceIndex];
    return tile !== undefined && world.wallColors[tile] ? world.wallColors[tile].slice() : null;
  }
  if (kind === 'bush') return world.bushColors[hit.instanceId]?.slice() ?? null;
  if (kind === 'pillar') return PILLAR_COLOR.slice();
  if (kind === 'water') return C.WATER_COLOR.slice();
  return null;
}

export function animateWorld(world, t) {
  const wm = world.waterMat;
  wm.opacity = 0.7 + Math.sin(t * 1.3) * 0.03;
  if (wm.normalMap) wm.normalMap.offset.set(t * 0.018, t * 0.011);
  if (world.foamMat) world.foamMat.opacity = 0.38 + Math.sin(t * 1.9) * 0.12;
  if (world.sky) world.sky.material.uniforms.time.value = t;
}
