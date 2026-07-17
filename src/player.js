// First-person player: walking, jumping, creative-style flying, and AABB
// collision against the voxel world and the build plate.

import * as THREE from 'three';
import { HEIGHT } from './world.js';
import { OFF } from './meshing.js';

const GRAVITY = -26;
const JUMP_SPEED = 8.6;     // ~1.3 block jump
const WALK_SPEED = 4.8;
const FLY_SPEED = 9;
const HALF = 0.3;           // half-width of the player box
const BODY_HEIGHT = 1.8;
const EYE_HEIGHT = 1.62;
const EDGE = OFF + 0.55;    // invisible walls just past the plate rim
const SKY_CAP = HEIGHT + 8; // how high you can fly

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Player {
  constructor() {
    this.pos = new THREE.Vector3(0, 0, 11.5); // feet center
    this.vel = new THREE.Vector3();
    this.yaw = 0;          // 0 = facing -Z (toward the plate center)
    this.pitch = -0.05;
    this.onGround = true;
    this.flying = false;
    this.eyeHeight = EYE_HEIGHT;
  }

  look(dx, dy, sensitivity = 0.0022) {
    this.yaw -= dx * sensitivity;
    this.pitch = clamp(this.pitch - dy * sensitivity, -1.55, 1.55);
  }

  syncCamera(camera) {
    camera.position.set(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  // input: { forward, back, left, right, jump, down } booleans
  step(dt, input, world) {
    dt = Math.min(dt, 0.05);

    // Horizontal velocity straight from input (snappy, Minecraft-like).
    const mx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const mz = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    const norm = Math.hypot(mx, mz) || 1;
    const speed = this.flying ? FLY_SPEED : WALK_SPEED;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // forward = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw)
    this.vel.x = ((-sin * mz + cos * mx) / norm) * speed;
    this.vel.z = ((-cos * mz - sin * mx) / norm) * speed;

    if (this.flying) {
      this.vel.y = ((input.jump ? 1 : 0) - (input.down ? 1 : 0)) * FLY_SPEED;
    } else {
      this.vel.y += GRAVITY * dt;
      if (input.jump && this.onGround) {
        this.vel.y = JUMP_SPEED;
        this.onGround = false;
      }
    }

    this._moveAxis(world, 'x', this.vel.x * dt);
    this._moveAxis(world, 'y', this.vel.y * dt);
    this._moveAxis(world, 'z', this.vel.z * dt);
  }

  // Internal (underscore-prefixed rather than a #private method: JS private
  // methods aren't supported until Safari 16.4, and this app must run on
  // iOS 16.0–16.3 tablets).
  _moveAxis(world, axis, delta) {
    const p = this.pos;
    p[axis] += delta;

    if (axis === 'x') p.x = clamp(p.x, -EDGE, EDGE);
    if (axis === 'z') p.z = clamp(p.z, -EDGE, EDGE);
    if (axis === 'y') {
      if (delta < 0) this.onGround = false;
      if (p.y <= 0) { // the build plate
        p.y = 0;
        this.vel.y = Math.max(0, this.vel.y);
        this.onGround = true;
      }
      p.y = Math.min(p.y, SKY_CAP);
    }

    // Voxel collision: resolve against any filled cell we now overlap.
    const x0 = Math.floor(p.x - HALF + OFF), x1 = Math.floor(p.x + HALF + OFF - 1e-9);
    const y0 = Math.max(0, Math.floor(p.y)), y1 = Math.floor(p.y + BODY_HEIGHT - 1e-9);
    const z0 = Math.floor(p.z - HALF + OFF), z1 = Math.floor(p.z + HALF + OFF - 1e-9);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cz = z0; cz <= z1; cz++) {
          if (!world.has(cx, cy, cz)) continue;
          if (axis === 'x') {
            p.x = delta > 0 ? cx - OFF - HALF - 1e-4 : cx + 1 - OFF + HALF + 1e-4;
            this.vel.x = 0;
          } else if (axis === 'z') {
            p.z = delta > 0 ? cz - OFF - HALF - 1e-4 : cz + 1 - OFF + HALF + 1e-4;
            this.vel.z = 0;
          } else if (delta > 0) { // bumped head
            p.y = cy - BODY_HEIGHT - 1e-4;
            this.vel.y = 0;
          } else {                // landed on a block
            p.y = cy + 1;
            this.vel.y = 0;
            this.onGround = true;
          }
          return;
        }
      }
    }
  }

  // Would a block at this cell intersect the player's body?
  overlapsCell([x, y, z]) {
    return x - OFF < this.pos.x + HALF && x + 1 - OFF > this.pos.x - HALF &&
           y < this.pos.y + BODY_HEIGHT && y + 1 > this.pos.y &&
           z - OFF < this.pos.z + HALF && z + 1 - OFF > this.pos.z - HALF;
  }

  // Nudge upward until the body isn't inside any block (used when entering
  // walk mode over an existing build).
  ensureFree(world) {
    let guard = 0;
    while (guard++ < HEIGHT + 4) {
      const x0 = Math.floor(this.pos.x - HALF + OFF), x1 = Math.floor(this.pos.x + HALF + OFF - 1e-9);
      const y0 = Math.max(0, Math.floor(this.pos.y)), y1 = Math.floor(this.pos.y + BODY_HEIGHT - 1e-9);
      const z0 = Math.floor(this.pos.z - HALF + OFF), z1 = Math.floor(this.pos.z + HALF + OFF - 1e-9);
      let blocked = false;
      for (let cx = x0; cx <= x1 && !blocked; cx++)
        for (let cy = y0; cy <= y1 && !blocked; cy++)
          for (let cz = z0; cz <= z1 && !blocked; cz++)
            if (world.has(cx, cy, cz)) blocked = true;
      if (!blocked) return;
      this.pos.y = Math.floor(this.pos.y) + 1;
    }
  }
}
