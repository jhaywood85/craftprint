// Undo/redo stack. Each operation is an array of cell changes:
//   { x, y, z, prev, next }  where prev/next are colorIndex or null (empty).
// One user action (including its mirrored twin) is one operation.

export class UndoStack {
  constructor(limit = 200) {
    this.limit = limit;
    this.past = [];
    this.future = [];
  }

  push(op) {
    if (!op || op.length === 0) return;
    this.past.push(op);
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  undo(world) {
    const op = this.past.pop();
    if (!op) return false;
    for (const { x, y, z, prev } of op) {
      if (prev == null) world.remove(x, y, z);
      else world.set(x, y, z, prev);
    }
    this.future.push(op);
    return true;
  }

  redo(world) {
    const op = this.future.pop();
    if (!op) return false;
    for (const { x, y, z, next } of op) {
      if (next == null) world.remove(x, y, z);
      else world.set(x, y, z, next);
    }
    this.past.push(op);
    return true;
  }

  clear() {
    this.past.length = 0;
    this.future.length = 0;
  }
}
