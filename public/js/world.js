// Baut die Arena aus der Karte: Boden, farbige Mauern, Buesche, Wasser, Saeulen.
// Stellt ausserdem die Farb-Pipette bereit: Welche Farbe hat die Oberflaeche,
// die der Strahl getroffen hat? Genau die nimmt man sich zum Anmalen.

import * as THREE from 'three';
import * as C from '/shared/constants.js';
import { idx, makeRng, wallColorAt } from '/shared/map.js';
import { tileHeight } from '/shared/physics.js';
import { makePillar, GEO, rgb } from './models.js';

const PX = 8;   // Texturpixel je Kachel - bewusst grob, flaechige Farben tarnen besser

function makeFloorTexture(map) {
  const cv = document.createElement('canvas');
  cv.width = map.w * PX; cv.height = map.h * PX;
  const ctx = cv.getContext('2d');
  const rng = makeRng(map.seed ^ 0x5bd1e995);
  const colors = new Array(map.w * map.h);
  for (let ty = 0; ty < map.h; ty++) {
    for (let tx = 0; tx < map.w; tx++) {
      const i = idx(tx, ty);
      const t = map.tiles[i];
      let c;
      if (t === C.T_WALL || t === C.T_PILLAR) c = C.WALL_COLOR;
      else if (t === C.T_BUSH) c = [78, 110, 72];
      else if (t === C.T_WATER) c = C.WATER_COLOR;
      else c = C.PALETTE[map.colors[i]];
      colors[i] = c;
      const v = (rng() - 0.5) * 6;
      ctx.fillStyle = `rgb(${c[0] + v | 0},${c[1] + v | 0},${c[2] + v | 0})`;
      ctx.fillRect(tx * PX, ty * PX, PX, PX);
      if (t === C.T_FLOOR) {
        ctx.fillStyle = 'rgba(0,0,0,0.07)';
        ctx.fillRect(tx * PX, ty * PX, PX, 1);
        ctx.fillRect(tx * PX, ty * PX, 1, PX);
      }
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return { tex, colors };
}

export function buildWorld(scene, map) {
  const group = new THREE.Group();
  const rng = makeRng(map.seed ^ 0x9e3779b9);
  const { tex, colors } = makeFloorTexture(map);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(map.w, map.h),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(map.w / 2, 0, map.h / 2);
  floor.receiveShadow = true;
  floor.userData.kind = 'floor';
  group.add(floor);

  const wallIdx = [], bushIdx = [], waterIdx = [];
  for (let i = 0; i < map.tiles.length; i++) {
    const t = map.tiles[i];
    if (t === C.T_WALL) wallIdx.push(i);
    else if (t === C.T_BUSH) bushIdx.push(i);
    else if (t === C.T_WATER) waterIdx.push(i);
  }
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();

  // Mauern: Zonenfarbe, damit man sich davor tarnen kann
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  const walls = new THREE.InstancedMesh(GEO.wall, wallMat, wallIdx.length);
  const wallColors = [];
  wallIdx.forEach((i, n) => {
    const tx = i % map.w, ty = (i / map.w) | 0;
    const h = tileHeight(map, tx, ty);
    m4.makeScale(1, h, 1);
    m4.setPosition(tx + 0.5, h / 2, ty + 0.5);
    walls.setMatrixAt(n, m4);
    const c = wallColorAt(map, tx, ty);
    wallColors.push(c);
    walls.setColorAt(n, rgb(c));
  });
  walls.castShadow = true;
  walls.receiveShadow = true;
  walls.userData.kind = 'wall';
  group.add(walls);

  // Buesche: dichte gruene Kugeln, man kann hineinlaufen
  const bushMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
  const bushes = new THREE.InstancedMesh(GEO.bush, bushMat, bushIdx.length * 2);
  const bushBase = rgb(C.BUSH_COLOR);
  const bushColors = [];
  let bn = 0;
  const q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
  for (const i of bushIdx) {
    const tx = i % map.w, ty = (i / map.w) | 0;
    for (let k = 0; k < 2; k++) {
      e.set(rng() * 0.6, rng() * Math.PI * 2, rng() * 0.6);
      q.setFromEuler(e);
      const sc = 0.7 + rng() * 0.5;
      s.set(sc, sc * 0.85, sc);
      p.set(tx + 0.3 + rng() * 0.4, 0.3 * sc, ty + 0.3 + rng() * 0.4);
      m4.compose(p, q, s);
      bushes.setMatrixAt(bn, m4);
      col.copy(bushBase).offsetHSL((rng() - 0.5) * 0.04, 0, (rng() - 0.5) * 0.1);
      bushes.setColorAt(bn, col);
      bushColors.push([Math.round(col.r * 255), Math.round(col.g * 255), Math.round(col.b * 255)]);
      bn++;
    }
  }
  bushes.castShadow = true;
  bushes.receiveShadow = true;
  bushes.userData.kind = 'bush';
  group.add(bushes);

  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x5aa7d8, transparent: true, opacity: 0.5, roughness: 0.15, metalness: 0.2, depthWrite: false,
  });
  const water = new THREE.InstancedMesh(GEO.water, waterMat, waterIdx.length);
  waterIdx.forEach((i, n) => {
    const tx = i % map.w, ty = (i / map.w) | 0;
    m4.makeRotationX(-Math.PI / 2);
    m4.setPosition(tx + 0.5, 0.03, ty + 0.5);
    water.setMatrixAt(n, m4);
  });
  water.userData.kind = 'water';
  group.add(water);

  const pillars = [];
  for (const a of map.anchors) {
    const pl = makePillar();
    pl.position.set(a.x / C.TILE, 0, a.y / C.TILE);
    pl.traverse((o) => { if (o.isMesh) o.userData.kind = 'pillar'; });
    group.add(pl);
    pillars.push(pl);
  }

  // Himmel/Boden-Rand: ein dunkler Kasten aussen, damit der Rand nicht ins Leere faellt
  scene.add(group);
  return { group, floor, walls, bushes, water, waterMat, pillars, floorColors: colors, wallColors, bushColors, map,
    pickables: [floor, walls, bushes, ...pillars.flatMap((pl) => pl.children)] };
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
    const i = idx(tx, ty);
    return world.floorColors[i] ? world.floorColors[i].slice() : null;
  }
  if (kind === 'wall') return world.wallColors[hit.instanceId]?.slice() ?? null;
  if (kind === 'bush') return world.bushColors[hit.instanceId]?.slice() ?? null;
  if (kind === 'pillar') return [58, 64, 80];
  if (kind === 'water') return C.WATER_COLOR.slice();
  return null;
}

export function animateWorld(world, t) {
  world.waterMat.opacity = 0.45 + Math.sin(t * 1.3) * 0.06;
}
