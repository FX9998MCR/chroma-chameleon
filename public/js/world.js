// Baut die Arena aus der Karte: Boden-Textur, Waende, Buesche, Wasser, Saeulen.

import * as THREE from 'three';
import * as C from '/shared/constants.js';
import { idx, makeRng } from '/shared/map.js';
import { makePillar, GEO, rgb } from './models.js';

const PX = 16;   // Texturpixel je Kachel

/** Bodentextur als Canvas: Zonenfarben mit leichter Koernung, Fugen zwischen Kacheln. */
function makeFloorTexture(map) {
  const cv = document.createElement('canvas');
  cv.width = map.w * PX; cv.height = map.h * PX;
  const ctx = cv.getContext('2d');
  const rng = makeRng(map.seed ^ 0x5bd1e995);
  for (let ty = 0; ty < map.h; ty++) {
    for (let tx = 0; tx < map.w; tx++) {
      const i = idx(tx, ty);
      const t = map.tiles[i];
      let c;
      if (t === C.T_WALL || t === C.T_PILLAR) c = C.WALL_COLOR;
      else if (t === C.T_BUSH) c = [70, 104, 66];
      else if (t === C.T_WATER) c = C.WATER_COLOR;
      else c = C.PALETTE[map.colors[i]];
      const v = (rng() - 0.5) * 12;
      ctx.fillStyle = `rgb(${c[0] + v | 0},${c[1] + v | 0},${c[2] + v | 0})`;
      ctx.fillRect(tx * PX, ty * PX, PX, PX);
      // Koernung
      for (let k = 0; k < 5; k++) {
        const g = (rng() - 0.5) * 22;
        ctx.fillStyle = `rgba(${c[0] + g | 0},${c[1] + g | 0},${c[2] + g | 0},0.7)`;
        ctx.fillRect(tx * PX + (rng() * PX) | 0, ty * PX + (rng() * PX) | 0, 2, 2);
      }
      // Fuge
      if (t === C.T_FLOOR) {
        ctx.fillStyle = 'rgba(0,0,0,0.10)';
        ctx.fillRect(tx * PX, ty * PX, PX, 1);
        ctx.fillRect(tx * PX, ty * PX, 1, PX);
      }
      if (t === C.T_WATER) {
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(tx * PX + 3, ty * PX + 6 + ((rng() * 4) | 0), 8, 1);
      }
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}

export function buildWorld(scene, map) {
  const group = new THREE.Group();
  const rng = makeRng(map.seed ^ 0x9e3779b9);

  // Boden
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(map.w, map.h),
    new THREE.MeshStandardMaterial({ map: makeFloorTexture(map), roughness: 0.95, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(map.w / 2, 0, map.h / 2);
  floor.receiveShadow = true;
  group.add(floor);

  // Waende (Instanzen), Buesche (Instanzen), Wasser (Instanzen)
  const wallIdx = [], bushIdx = [], waterIdx = [];
  for (let i = 0; i < map.tiles.length; i++) {
    const t = map.tiles[i];
    if (t === C.T_WALL) wallIdx.push(i);
    else if (t === C.T_BUSH) bushIdx.push(i);
    else if (t === C.T_WATER) waterIdx.push(i);
  }
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();

  const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  const walls = new THREE.InstancedMesh(GEO.wall, wallMat, wallIdx.length);
  const wallBase = rgb(C.WALL_COLOR);
  wallIdx.forEach((i, n) => {
    const tx = i % map.w, ty = (i / map.w) | 0;
    // Aussenmauer etwas hoeher, Innenmauern variieren leicht.
    const edge = tx < 2 || ty < 2 || tx >= map.w - 2 || ty >= map.h - 2;
    const h = edge ? 1.35 : 0.85 + rng() * 0.25;
    m4.makeScale(1, h, 1);
    m4.setPosition(tx + 0.5, 0.7 * h, ty + 0.5);
    walls.setMatrixAt(n, m4);
    col.copy(wallBase).offsetHSL(0, 0, (rng() - 0.5) * 0.08);
    walls.setColorAt(n, col);
  });
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  const bushMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
  const bushes = new THREE.InstancedMesh(GEO.bush, bushMat, bushIdx.length * 2);
  const bushBase = rgb(C.BUSH_COLOR);
  let bn = 0;
  const q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
  for (const i of bushIdx) {
    const tx = i % map.w, ty = (i / map.w) | 0;
    for (let k = 0; k < 2; k++) {
      e.set(rng() * 0.6, rng() * Math.PI * 2, rng() * 0.6);
      q.setFromEuler(e);
      const sc = 0.55 + rng() * 0.35;
      s.set(sc, sc * 0.7, sc);
      p.set(tx + 0.3 + rng() * 0.4, 0.18, ty + 0.3 + rng() * 0.4);
      m4.compose(p, q, s);
      bushes.setMatrixAt(bn, m4);
      col.copy(bushBase).offsetHSL((rng() - 0.5) * 0.04, 0, (rng() - 0.5) * 0.12);
      bushes.setColorAt(bn, col);
      bn++;
    }
  }
  bushes.castShadow = true;
  bushes.receiveShadow = true;
  group.add(bushes);

  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x5aa7d8, transparent: true, opacity: 0.45, roughness: 0.15, metalness: 0.2, depthWrite: false,
  });
  const water = new THREE.InstancedMesh(GEO.water, waterMat, waterIdx.length);
  waterIdx.forEach((i, n) => {
    const tx = i % map.w, ty = (i / map.w) | 0;
    m4.makeRotationX(-Math.PI / 2);
    m4.setPosition(tx + 0.5, 0.035, ty + 0.5);
    water.setMatrixAt(n, m4);
  });
  group.add(water);

  // Saeulen
  const pillars = [];
  for (const a of map.anchors) {
    const pl = makePillar();
    pl.position.set(a.x / C.TILE, 0, a.y / C.TILE);
    group.add(pl);
    pillars.push(pl);
  }

  scene.add(group);
  return { group, floor, walls, bushes, water, waterMat, pillars };
}

/** Kleine Lebendigkeit: Wasser schimmert, Ankerringe drehen sich. */
export function animateWorld(world, t) {
  world.waterMat.opacity = 0.40 + Math.sin(t * 1.3) * 0.06;
  for (const pl of world.pillars) pl.userData.ring.rotation.z = t * 0.8;
}
