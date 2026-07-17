// On-screen first-person controls for touch devices (tablets/phones), where
// there's no keyboard for WASD and no pointer lock for mouse-look.
//
// Layout & gestures:
//   • Thumbstick, lower-left — walk (writes input.forward/back/left/right).
//   • Anywhere else on the screen:
//       - a quick TAP (finger barely moves)      → place a block
//       - a press-and-HOLD that stays still      → break blocks (repeats)
//       - a DRAG                                  → look around
//     Aim is always the center crosshair.
//   • Jump button (lower-right, top): tap = jump; double-tap = toggle fly;
//     while flying, hold = go up.
//   • Crouch button (below Jump): while flying, hold = go down.
//
// Writes to the same `input` object the keyboard fills and calls the same
// place/break/look functions, so physics and building code stay shared.

export function setupTouchControls(app, {
  input, player, sounds, placeAt, breakAt, onLook,
}) {
  const layer = document.getElementById('touchControls');
  const stickBase = document.getElementById('touchStickBase');
  const stickKnob = document.getElementById('touchStickKnob');
  const btnJump = document.getElementById('touchJump');
  const btnCrouch = document.getElementById('touchCrouch');

  const STICK_RADIUS = 52;   // px travel before full speed
  const LOOK_SENS = 0.006;   // radians per px dragged
  const TAP_MOVE = 12;       // px: movement under this is a tap/hold, not a look
  const HOLD_MS = 320;       // ms held (still) before it becomes "break"
  const BREAK_REPEAT = 240;  // ms between repeated breaks while holding

  // --- Movement thumbstick ---------------------------------------------------
  let stickId = null, stickCX = 0, stickCY = 0;

  function setStick(dx, dy) {
    const len = Math.hypot(dx, dy);
    const cl = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
    const kx = dx * cl, ky = dy * cl;
    stickKnob.style.transform = `translate(${kx}px, ${ky}px)`;
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
    e.stopPropagation();
  });
  stickBase.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId) return;
    setStick(e.clientX - stickCX, e.clientY - stickCY);
    e.preventDefault();
  });
  const endStick = (e) => { if (e.pointerId === stickId) clearStick(); };
  stickBase.addEventListener('pointerup', endStick);
  stickBase.addEventListener('pointercancel', endStick);

  // --- Screen gesture: tap = place, hold = break, drag = look ----------------
  // One finger at a time drives this. We start neutral, and as the finger
  // moves or time passes we resolve into one of the three intents.
  let gid = null;             // active gesture pointer id
  let startX = 0, startY = 0, lastX = 0, lastY = 0;
  let mode = null;            // null | 'look' | 'break'
  let holdTimer = null, breakTimer = null;

  function clearTimers() {
    clearTimeout(holdTimer); holdTimer = null;
    clearInterval(breakTimer); breakTimer = null;
  }

  layer.addEventListener('pointerdown', (e) => {
    if (gid !== null) return;                 // ignore extra fingers here
    gid = e.pointerId;
    startX = lastX = e.clientX;
    startY = lastY = e.clientY;
    mode = null;
    // If the finger stays put for HOLD_MS, it's a break-and-hold. Break at the
    // finger's latest position (it barely moves during a hold).
    holdTimer = setTimeout(() => {
      if (mode !== null) return;              // already became a look-drag
      mode = 'break';
      breakAt(lastX, lastY);
      breakTimer = setInterval(() => breakAt(lastX, lastY), BREAK_REPEAT);
    }, HOLD_MS);
  });

  layer.addEventListener('pointermove', (e) => {
    if (e.pointerId !== gid) return;
    const movedFromStart = Math.hypot(e.clientX - startX, e.clientY - startY);
    if (mode === null && movedFromStart > TAP_MOVE) {
      // Became a look-drag: cancel the pending break.
      mode = 'look';
      clearTimers();
    }
    if (mode === 'look') {
      onLook(e.clientX - lastX, e.clientY - lastY, LOOK_SENS);
    }
    lastX = e.clientX; lastY = e.clientY;
    e.preventDefault();
  });

  function endGesture(e) {
    if (e.pointerId !== gid) return;
    const movedFromStart = Math.hypot(e.clientX - startX, e.clientY - startY);
    if (mode === null && movedFromStart <= TAP_MOVE) {
      placeAt(e.clientX, e.clientY);           // quick tap → place where tapped
    }
    clearTimers();
    gid = null;
    mode = null;
  }
  layer.addEventListener('pointerup', endGesture);
  layer.addEventListener('pointercancel', (e) => { if (e.pointerId === gid) { clearTimers(); gid = null; mode = null; } });

  // Stop stick/button touches from also triggering the screen gesture.
  for (const el of [stickBase, btnJump, btnCrouch]) {
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // --- Jump button: tap = jump, double-tap = fly toggle, hold = up (flying) --
  let jumpDownAt = 0, lastJumpTap = 0, jumpPid = null;
  btnJump.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    jumpPid = e.pointerId;
    jumpDownAt = e.timeStamp;
    btnJump.classList.add('pressed');
    if (player.flying) {
      input.jump = true;                       // hold to rise
    } else {
      input.jump = true;                       // triggers a hop in player.step
    }
    // Double-tap detection toggles flying.
    if (e.timeStamp - lastJumpTap < 320) toggleFly();
    lastJumpTap = e.timeStamp;
  });
  const jumpUp = (e) => {
    if (jumpPid !== null && e.pointerId !== jumpPid) return;
    jumpPid = null;
    input.jump = false;
    btnJump.classList.remove('pressed');
  };
  btnJump.addEventListener('pointerup', jumpUp);
  btnJump.addEventListener('pointercancel', jumpUp);

  // --- Crouch button: hold = down (flying) / crouch (walking) ----------------
  let crouchPid = null;
  btnCrouch.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    crouchPid = e.pointerId;
    input.down = true;
    btnCrouch.classList.add('pressed');
  });
  const crouchUp = (e) => {
    if (crouchPid !== null && e.pointerId !== crouchPid) return;
    crouchPid = null;
    input.down = false;
    btnCrouch.classList.remove('pressed');
  };
  btnCrouch.addEventListener('pointerup', crouchUp);
  btnCrouch.addEventListener('pointercancel', crouchUp);

  function toggleFly() {
    player.flying = !player.flying;
    player.vel.y = 0;
    layer.classList.toggle('flying', player.flying);
    sounds.click();
    app.ui?.toast(player.flying
      ? '🕊️ Flying! Hold ⬆️ to go up, ⬇️ to go down'
      : '🚶 Walking again');
  }

  return {
    show() { layer.classList.add('active'); },
    hide() {
      layer.classList.remove('active');
      clearStick();
      clearTimers();
      input.jump = input.down = false;
      gid = null; mode = null;
    },
    syncFly() { layer.classList.toggle('flying', player.flying); },
  };
}
