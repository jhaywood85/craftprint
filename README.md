# 🧱 CraftPrint — Build it. Print it!

A Minecraft-style 3D building game for kids. Walk around **inside** your own
block world in first person, build with colorful blocks, then press
**🖨️ Print It!** to export a watertight STL file ready for any 3D printer.

## Play

Double-click **`play.command`** (or run `npm start`) and the game opens at
<http://localhost:4173>. Everything runs locally in the browser — no internet
needed after setup, nothing is uploaded anywhere.

## Install on an iPad / tablet

**Live at https://jhaywood85.github.io/craftprint/** — open that in **Safari**
on the iPad and tap **Share → Add to Home Screen**.

CraftPrint is an installable web app (PWA): once added it It then has its own icon, launches
fullscreen with no browser bars, and works **fully offline**. Touch controls,
the notch/home-bar safe areas, and pinch-zoom are all handled. See
**[INSTALL-ON-IPAD.md](INSTALL-ON-IPAD.md)** for the two setup options (serve
from the Mac, or host it once so it lives on the iPad).

> On touch devices the game starts in **Camera view** (tap to place, drag to
> spin, pinch to zoom) since there's no keyboard to walk with.

## How to play

There are two views, switchable any time with the **🎥 Camera view / 🚶 Walk
inside** button. Walk mode is the default on computers; touch devices default
to Camera view (no keyboard to walk with).

### 🚶 Walk inside (first person — like Minecraft)

Click the world once to grab the mouse, then:

| Action | How |
| --- | --- |
| Walk | **WASD** or arrow keys |
| Look | **Move the mouse** |
| Place a block | **Left-click** |
| Break a block | **Right-click** |
| Copy a block (color + shape) | **Middle-click** |
| Jump | **Space** |
| Fly | Tap **Space twice** (Space = up, Shift = down) |
| Pick a color | **Scroll wheel** or number keys **1–9, 0** |
| Switch cube ↔ wedge | **Q** (or the shape bar) |
| Turn the block | **R** |
| Paint what you're aiming at | **F** |
| Free the mouse | **Esc** (click the world to dive back in) |

### 🎥 Camera view (spin around from outside)

| Action | How |
| --- | --- |
| Add a block | Pick **Build**, click the ground or a block |
| Spin / zoom / slide | **Drag** / **Scroll** / **Right-drag** |
| Erase | 🧽 Eraser tool, or quick **right-click** any block |
| Recolor | 🎨 Paint tool |

### Everywhere

| Action | How |
| --- | --- |
| Choose a shape | 🧱 Cube or 🔺 Wedge (45° edge) — shape bar or **Q**; **R** turns it |
| Build symmetrically | 🦋 Mirror mode (**M**) — wedges flip to mirror too |
| Undo / redo | **Ctrl+Z** / **Ctrl+Shift+Z** |
| Save creations | 📦 My Stuff → 📸 Save |

## Printing (for grown-ups)

- **🖨️ Print It!** exports a binary STL: watertight, consistently oriented,
  Z-up, sitting flat on the bed at origin — drop it straight into
  PrusaSlicer / Cura / Bambu Studio.
- The size chips choose the edge length of one block (3 / 5 / 8 mm); the
  dialog shows the final print size in cm. Build area is 32×32×32 blocks.
- The export dialog warns about **floating blocks** (not connected to the
  ground) — those would print as separate loose pieces — and can highlight
  them in red.
- Colors are on-screen fun only; the STL is one solid piece.

## Under the hood

- Plain ES modules + [three.js](https://threejs.org) (vendored in `vendor/`,
  no build step, works offline).
- First-person movement (`src/player.js`): gravity, jumping, creative flying,
  and AABB collision against both the voxel blocks and the build-plate edges,
  using Pointer Lock for mouse look.
- Block shapes (`src/shapes.js`): each cell stores a shape (cube or wedge) and
  a rotation. The geometry module is shared by the renderer and the STL
  exporter so a block looks identical on screen and in the print. A wedge is a
  triangular prism — a cube with one vertical edge sliced at 45°.
- Creations autosave to the browser's localStorage; **My Stuff** keeps named
  saves with thumbnails.
- STL exporter (`src/stl.js`) emits only exterior faces, culling a face only
  when both it and its neighbor fully cover the shared unit square (sloped
  faces are never culled), so the model stays watertight even with wedges.
  `npm test` verifies structure, watertightness, exact volume (cubes and
  half-volume wedges in all four rotations), and the y-up → z-up axis mapping.
