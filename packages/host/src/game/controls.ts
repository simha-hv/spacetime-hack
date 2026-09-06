/**
 * Stick reading -> world movement.
 *
 * Four sign conventions meet here, which is exactly why this is its own
 * function with its own test rather than an expression buried in the match
 * loop — the first version got it backwards and shipped, and "up moves me down"
 * is the single most disorienting bug a gamepad can have.
 *
 *   1. The controller reports screen coordinates: +Y is DOWN.
 *      Push the thumb up  -> axisY = -1.
 *   2. The camera sits at +Z and looks toward -Z.
 *      So "away from the viewer", up the screen, is -Z.
 *   3. Therefore up on the stick must produce moveZ = -1.
 *   4. axisY is already -1. The mapping is the IDENTITY, not a negation.
 *
 * Negating it means up on the stick walks the player toward the camera, i.e.
 * down the screen. Both conventions are individually correct, which is what
 * makes the mistake so easy: it reads like it needs a flip and does not.
 *
 * If the camera is ever moved to look from -Z, this is the one place to change.
 */
export function stickToMove(axisX: number, axisY: number): { moveX: number; moveZ: number } {
  return { moveX: axisX, moveZ: axisY };
}
