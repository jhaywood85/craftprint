// Renders the voxel world as a single InstancedMesh (one instance per block,
// per-instance color), plus the printer-bed base plate and build-volume frame.

import * as THREE from 'three';
import { SIZE, HEIGHT, SHAPE_CUBE, SHAPE_WEDGE } from './world.js';
import { shapeTriangles } from './shapes.js';

// World is rendered centered on the origin: cell (x,y,z) occupies
// [x-OFF, x+1-OFF] x [y, y+1] x [z-OFF, z+1-OFF].
export const OFF = SIZE / 2;

const MAX_INSTANCES = SIZE * SIZE * HEIGHT;

// A subtle rounded border baked into the face texture gives blocks that
// friendly "toy brick" definition without extra geometry.
function makeBlockTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  // Soft shading toward the edges.
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size * 0.72);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.10)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Rounded inner border.
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.roundRect(5, 5, size - 10, size - 10, 20);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// A unit-cell BufferGeometry (centered at origin, side 1) built from the
// shared shape triangles, so the rendered mesh matches the exported STL. The
// geometry is centered so that per-instance rotation about the block center
// (matching the exporter's rotPoint) is a plain matrix rotation here.
function shapeGeometry(shape) {
  const tris = shapeTriangles(shape, 0);
  const positions = [];
  const uvs = [];
  for (const tri of tris) {
    // Choose a UV projection per triangle from its dominant normal so the
    // toy-brick texture lies flat on each face.
    const [a, b, c] = tri;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]].map(Math.abs);
    const proj = n[0] >= n[1] && n[0] >= n[2] ? (p) => [p[1], p[2]]  // x-face -> (y,z)
              : n[1] >= n[2] ? (p) => [p[0], p[2]]                    // y-face -> (x,z)
              : (p) => [p[0], p[1]];                                  // z-face -> (x,y)
    for (const p of tri) {
      positions.push(p[0] - 0.5, p[1] - 0.5, p[2] - 0.5);
      const [uu, vv] = proj(p);
      uvs.push(uu, vv);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

// One InstancedMesh per shape (cube + wedge), both sharing the toy-brick
// material with per-instance color and rotation. Picking stays face-accurate
// because each instance is a real transformed copy of the shape geometry.
class ShapeLayer {
  constructor(scene, geometry, material) {
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_INSTANCES);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.indexToCell = []; // instanceId -> [x, y, z]
    scene.add(this.mesh);
  }
}

export class WorldRenderer {
  constructor(scene, palette) {
    this.paletteColors = palette.map((p) => new THREE.Color(p.hex));
    const material = new THREE.MeshLambertMaterial({ map: makeBlockTexture() });

    this.layers = {
      [SHAPE_CUBE]: new ShapeLayer(scene, shapeGeometry(SHAPE_CUBE), material),
      [SHAPE_WEDGE]: new ShapeLayer(scene, shapeGeometry(SHAPE_WEDGE), material),
    };
    // Meshes the raycaster should test.
    this.meshes = [this.layers[SHAPE_CUBE].mesh, this.layers[SHAPE_WEDGE].mesh];

    this._m = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._one = new THREE.Vector3(1, 1, 1);
    this._axis = new THREE.Vector3(0, 1, 0);
  }

  // Resolve a raycast hit on any layer back to its cell record.
  cellForHit(hit) {
    for (const shape of [SHAPE_CUBE, SHAPE_WEDGE]) {
      const layer = this.layers[shape];
      if (hit.object === layer.mesh) return layer.indexToCell[hit.instanceId] || null;
    }
    return null;
  }

  update(world) {
    const counts = { [SHAPE_CUBE]: 0, [SHAPE_WEDGE]: 0 };
    world.forEach((x, y, z, rec) => {
      const layer = this.layers[rec.s] || this.layers[SHAPE_CUBE];
      const i = counts[rec.s in this.layers ? rec.s : SHAPE_CUBE]++;
      this._pos.set(x + 0.5 - OFF, y + 0.5, z + 0.5 - OFF);
      // r=1 turns +X -> +Z (CCW seen from above) to match the exporter, which
      // is a rotation of -r*90° about +Y in three.js's right-handed frame.
      this._quat.setFromAxisAngle(this._axis, -rec.r * Math.PI / 2);
      this._m.compose(this._pos, this._quat, this._one);
      layer.mesh.setMatrixAt(i, this._m);
      layer.mesh.setColorAt(i, this.paletteColors[rec.c] || this.paletteColors[0]);
      layer.indexToCell[i] = [x, y, z];
    });
    for (const shape of [SHAPE_CUBE, SHAPE_WEDGE]) {
      const layer = this.layers[shape];
      layer.mesh.count = counts[shape];
      layer.indexToCell.length = counts[shape];
      layer.mesh.instanceMatrix.needsUpdate = true;
      if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
      layer.mesh.computeBoundingSphere();
    }
  }
}

function makeBedTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#465062';
  ctx.fillRect(0, 0, size, size);

  // Grid aligned to block cells: the bed is SIZE+2 units wide with a 1-unit rim.
  const units = SIZE + 2;
  const px = size / units;
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 2;
  for (let u = 1; u < units; u++) {
    ctx.beginPath(); ctx.moveTo(u * px, px); ctx.lineTo(u * px, size - px); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px, u * px); ctx.lineTo(size - px, u * px); ctx.stroke();
  }
  // Rim.
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 5;
  ctx.strokeRect(px, px, size - 2 * px, size - 2 * px);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function addBed(scene) {
  const side = new THREE.MeshLambertMaterial({ color: '#394151' });
  const top = new THREE.MeshLambertMaterial({ map: makeBedTexture() });
  const bottom = new THREE.MeshLambertMaterial({ color: '#2e3542' });
  const bed = new THREE.Mesh(
    new THREE.BoxGeometry(SIZE + 2, 1.2, SIZE + 2),
    [side, side, top, bottom, side, side]
  );
  bed.position.y = -0.6;
  bed.receiveShadow = true;
  scene.add(bed);
  return bed;
}

export function addBuildVolume(scene) {
  const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(SIZE, HEIGHT, SIZE));
  const frame = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: '#6fa8d8', transparent: true, opacity: 0.22 })
  );
  frame.position.y = HEIGHT / 2;
  scene.add(frame);
  return frame;
}
