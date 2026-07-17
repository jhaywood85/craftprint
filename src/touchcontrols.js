// On-screen first-person controls for touch devices (tablets/phones), where
// there's no keyboard for WASD and no pointer lock for mouse-look.
//
// Layout: a virtual thumbstick on the lower-left drives movement; dragging
// anywhere on the right half of the screen looks around; action buttons on
// the lower-right place / break / jump / fly. All of this only shows while
// the game is in first-person ("walk") mode AND on a touch device.
//
// It writes to the same `input` object the keyboard fills, and calls the same
// place/break/look functions, so the physics and building code are shared.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function setupTouchControls(app, {
  input, player, sounds, walkPlace, walkBreak, onLook,
}) {
  const layer = document.getElementById('touchControls');
  const stickBase = document.getElementById('touchStickBase');
  const stickKnob = document.getElementById('touchStickKnob');
  const btnJump = document.getElementById('touchJump');
  const btnFly = document.getElementById('touchFly');
  const btnPlace = document.getElementById('touchPlace');
  const btnBreak = document.getElementById('touchBreak');

  const STICK_RADIUS = 52;   // px travel before full speed
  const LOOK_SENS = 0.006;   // radians per px dragged

  // --- Movement thumbstick ---------------------------------------------------
  // Fixed-position stick: touch down inside its zone, drag to steer.
  let stickId = null;
  let stickCX = 0, stickCY = 0;

  function setStick(dx, dy) {
    const len = Math.hypot(dx, dy);
    const cl = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
    const kx = dx * cl, ky = dy * cl;
    stickKnob.style.transform = `translate(${kx}px, ${ky}px)`;
    // Map to WASD-style input. Up on screen = forward.
    const nx = kx / STICK_RADIUS, ny = ky / STICK_RADIUS;
    const dead = 0.18;
    input.forward = ny < -dead;
    input.back = ny > dead;
    input.left = nx < -dead;
    input.right = nx > dead;
  }

  function clearStick() {
    stickId = null;
    stickKnob.style.transform = 'translate(0px, 0px)';
    input.forward = input.back = input.left = input.right = false;
  }

  stickBase.addEventListener('pointerdown', (e) => {
    if (stickId !== null) return;
    stickId = e.pointerId;
    const r = stickBase.getBoundingClientRect();
    stickCX = r.left + r.width / 2;
    stickCY = r.top + r.height / 2;
    setStick(e.clientX - stickCX, e.clientY - stickCY);
    try { stickBase.setPointerCapture?.(e.pointerId); } catch { /* no real pointer */ }
    e.preventDefault();
  });
  stickBase.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId) return;
    setStick(e.clientX - stickCX, e.clientY - stickCY);
    e.preventDefault();
  });
  const endStick = (e) => { if (e.pointerId === stickId) clearStick(); };
  stickBase.addEventListener('pointerup', endStick);
  stickBase.addEventListener('pointercancel', endStick);

  // --- Look drag (right half of the screen) ---------------------------------
  let lookId = null, lastX = 0, lastY = 0;

  layer.addEventListener('pointerdown', (e) => {
    // Only start a look-drag on the bare look zone (not the stick/buttons,
    // which stopPropagation below), and only if no drag is active.
    if (lookId !== null) return;
    lookId = e.pointerId;
    lastX = e.clientX; lastY = e.clientY;
  });
  layer.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId) return;
    onLook((e.clientX - lastX), (e.clientY - lastY), LOOK_SENS);
    lastX = e.clientX; lastY = e.clientY;
    e.preventDefault();
  });
  const endLook = (e) => { if (e.pointerId === lookId) lookId = null; };
  layer.addEventListener('pointerup', endLook);
  layer.addEventListener('pointercancel', endLook);

  // Keep stick/button touches from also starting a look-drag.
  for (const el of [stickBase, btnJump, btnFly, btnPlace, btnBreak]) {
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // --- Action buttons --------------------------------------------------------
  // Place / break auto-repeat while held, like holding the mouse button.
  function holdButton(el, fn) {
    let timer = null, pid = null;
    el.addEventListener('pointerdown', (e) => {
      pid = e.pointerId;
      try { el.setPointerCapture?.(e.pointerId); } catch { /* no real pointer */ }
      el.classList.add('pressed');
      fn();
      timer = setInterval(fn, 240);
      e.preventDefault();
    });
    const stop = (e) => {
      if (pid !== null && e.pointerId !== pid) return;
      clearInterval(timer); timer = null; pid = null;
      el.classList.remove('pressed');
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    el.addEventListener('pointerleave', stop);
  }
  holdButton(btnPlace, walkPlace);
  holdButton(btnBreak, walkBreak);

  // Jump is a tap; a quick double-tap toggles flying (mirrors the Space keys).
  let lastJumpTap = 0;
  btnJump.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    input.jump = true;
    const now = e.timeStamp;
    if (now - lastJumpTap < 320) toggleFly();
    lastJumpTap = now;
  });
  btnJump.addEventListener('pointerup', () => { input.jump = false; });
  btnJump.addEventListener('pointercancel', () => { input.jump = false; });

  function toggleFly() {
    player.flying = !player.flying;
    player.vel.y = 0;
    btnFly.classList.toggle('on', player.flying);
    layer.classList.toggle('flying', player.flying);
    sounds.click();
    app.ui?.toast(player.flying ? '🕊️ Flying! Use ⬆️ / ⬇️ to go up and down' : '🚶 Walking again');
  }

  // In fly mode the Jump button becomes "up" and Fly becomes "down". We keep
  // it simple: while flying, holding Jump sets input.jump (up) and holding Fly
  // sets input.down; the player module already reads those for vertical fly.
  let flyDownTimer = null;
  btnFly.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (player.flying) { input.down = true; btnFly.classList.add('pressed'); }
    else { toggleFly(); }
  });
  const flyUp = () => { input.down = false; btnFly.classList.remove('pressed'); };
  btnFly.addEventListener('pointerup', flyUp);
  btnFly.addEventListener('pointercancel', flyUp);

  return {
    show() { layer.classList.add('active'); },
    hide() {
      layer.classList.remove('active');
      clearStick();
      input.jump = input.down = false;
    },
    // Reflect fly state if it was toggled elsewhere.
    syncFly() {
      btnFly.classList.toggle('on', player.flying);
      layer.classList.toggle('flying', player.flying);
    },
  };
}
