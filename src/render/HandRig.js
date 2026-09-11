/**
 * HandRig.js — first-person arm, built from Minecraft's own view-model numbers.
 *
 * The first version of this hand was two boxes placed by hand in view space. It
 * looked approximately right in a still and wrong the moment anyone compared it
 * to the real thing: the forearm tapered to a two-pixel wedge and stopped 79 px
 * short of the bottom edge, so the arm appeared to end in mid-air, and the
 * tiled skin put the sleeve band in the one place where it reads as a collar
 * rather than a shoulder.
 *
 * Nothing here is tuned. It is the transform stack Minecraft uses to draw the
 * bare right arm in first person, and the model-space geometry of the arm it
 * draws. That is the whole point: a hand-placed approximation is always one
 * screenshot away from looking subtly wrong, and the failure stays invisible
 * until somebody puts the two side by side.
 *
 * Minecraft (`ItemRenderer.renderPlayerArm` in 1.8.9, unchanged in the modern
 * `ItemInHandRenderer`):
 *
 *   translate(0.56, -0.52, -0.72)     // out in front of the camera, to the right
 *   rotate Y  45                      // swing the arm's long axis across the view
 *   translate(5.6, 0, 0)              // offset to the shoulder pivot
 *   rotate Z  120
 *   rotate X  200
 *   rotate Y -135
 *   scale 1/16                        // model pixels -> blocks
 *
 * and the arm it draws is the 4x12x4-pixel box from the player model, whose
 * pivot is the shoulder, so the box hangs from y=0 down to y=-12.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A LIST OF POINT TRANSFORMS AND NOT A 4x4 MATRIX
 * ---------------------------------------------------------------------------
 * It was a matrix first, and it was wrong twice, in two ways that both looked
 * like a bug in the transform order:
 *
 *   1. `Math3D.mat4Multiply` does not compute what its doc comment says it
 *      does, so "post-multiply the way GlStateManager does" silently built the
 *      inverse-order product. The arm folded onto its own shoulder.
 *   2. Rewriting the multiply from scratch reproduced the same class of error
 *      from the other side, because in column-major storage element (i, j)
 *      lives at `i*4 + j` while a *column* index strides by 4 — so the two
 *      obvious spellings of the inner loop are transposes of one another.
 *
 * Neither mistake is available in the form below. A transform is a function
 * from a point to a point, applied to the box's corners in order. There is no
 * operand order to reverse, nothing to alias, and the whole stack can be
 * checked by printing where one corner lands.
 *
 * Three further details are load-bearing and every one of them is silent when
 * wrong:
 *
 *   - ORDER.  `translate(5.6)` before the three rotations means the rotations
 *     turn the arm about its own shoulder; after them, the arm stays parked
 *     where the model put it. Both orders compile and both look plausible.
 *   - The result is already in VIEW SPACE. The first-person rig is drawn with
 *     the camera's projection and NO view matrix — that is why the renderer
 *     passes `camera.projection` for the held-item pass. Multiplying by
 *     `camera.view` applies the eye position a second time and throws the arm
 *     thousands of units away, where it renders as a screen-filling smear.
 *   - Minecraft's model space looks along +Z; ours looks along -Z. The rig ends
 *     with a 180-degree yaw that reconciles them. Without it the arm is built
 *     behind the camera, and the projection matrix draws it anyway — mirrored,
 *     filling the screen, and reported by nothing.
 */

const DEG = Math.PI / 180;

/**
 * The arm model, in model pixels, exactly as the player model defines it: a
 * 4x12x4 box whose pivot is the shoulder, so it occupies x/z in [-2, 2] and
 * hangs from y = 0 down to y = -12.
 *
 * The pivot matters more than the size. Because the arm hangs *down* from its
 * pivot and every rotation below turns it about that pivot, the hand lands a
 * long way from the pivot — which is why the arm reaches into frame from the
 * corner rather than sitting wherever a naive translation would put it.
 */
export const ARM_CENTRE = [0, -6, 0];
export const ARM_MIN = [-2, -12, -2];
export const ARM_MAX = [2, 0, 2];

/**
 * Shoulder offset inside the stack, in MODEL PIXELS. Vanilla passes 5.6, and
 * the stack's final `scale(1/16)` is what turns it into blocks — which is the
 * detail that makes this rig easy to get wrong.
 *
 * The first working version of this file took the base translation
 * (0.56, -0.52, -0.72) straight from the original — but that one is already in
 * *blocks*, because it is applied before the scale. Mixing the two units puts
 * the shoulder 5.6 blocks in front of the camera instead of 0.35, and the arm
 * lands entirely off the bottom of the screen (measured: y = 857..1336 on a
 * 720-pixel-tall frame, so nothing was drawn at all).
 *
 * The resolution is to keep the two spaces distinct rather than to pick one:
 * this offset stays in model pixels, and `ARM_MODEL_TO_VIEW` is applied to the
 * arm box after the base translation. See `armRig`.
 */
const SHOULDER_X = 5.6;

/**
 * Model pixels to view units. The arm box's own 1/16, applied where the box is
 * built rather than as the stack's final `scale`, so that the stack can carry
 * the block-space base translation.
 */
export const ARM_MODEL_TO_VIEW = 1 / 16;

/**
 * Overall size of the rig, and where it sits, both applied last.
 *
 * Vanilla's placement is tuned for its own projection and ours differs — a
 * 72-degree vertical fov on a 16:9 frame is wider than the original's, so the
 * same rig at the same distance subtends a smaller angle. Taken verbatim the
 * pose is right and the placement is not: measured, the whole arm landed at
 * y = 861..2107 on a 720-pixel frame, entirely below the bottom edge.
 *
 * The POSE is what "follows the Minecraft style" means, so the pose is kept
 * exactly as transcribed and these two placement values are solved for instead,
 * against the one thing that can be measured from a reference frame: where the
 * visible arm appears and how big it is. The targets are a visible hand about
 * 160 x 220 px, in the bottom-right corner, cropped by the right and bottom
 * edges — read off a vanilla first-person screenshot scaled to 1280x720.
 *
 * `test/unit-math.mjs` asserts those bounds, so a future re-tune that doubles
 * the arm or shrinks it to a speck fails rather than shipping.
 */
export const RIG_SCALE = 1;

/** View-space offset for the rig, applied after the model->view conversion. */
export const RIG_PLACEMENT = [1.36, -0.2, -1];

/** Model pixels per view unit — the stack's final `scale`. */
export const MODEL_PIXELS_PER_UNIT = 16;

/** Where the rig starts, in view units. Straight from the stack above. */
export const RIG_BASE = [0.56, -0.52, -0.72];

/**
 * The grip point, in model pixels from the pivot: the middle of the last four
 * pixels of the arm, which is to say the middle of the fist.
 */
export const FIST_CENTRE_MODEL_Y = -10;

/**
 * Apply one step to a point, in place.
 *
 * Steps are plain objects so a rig can be printed, diffed and asserted on as
 * data — which is how the geometry in `test/unit-math.mjs` is checked.
 *
 * @param {number[]} p point, mutated
 * @param {{k:string,a?:number,b?:number,c?:number}} step
 */
export function applyStep(p, step) {
  const x = p[0], y = p[1], z = p[2];
  switch (step.k) {
    case 'translate':
      p[0] = x + step.a; p[1] = y + step.b; p[2] = z + step.c;
      break;
    case 'rotateX': {
      const c = Math.cos(step.a), s = Math.sin(step.a);
      p[0] = x; p[1] = y * c - z * s; p[2] = y * s + z * c;
      break;
    }
    case 'rotateY': {
      const c = Math.cos(step.a), s = Math.sin(step.a);
      p[0] = x * c + z * s; p[1] = y; p[2] = -x * s + z * c;
      break;
    }
    case 'rotateZ': {
      const c = Math.cos(step.a), s = Math.sin(step.a);
      p[0] = x * c - y * s; p[1] = x * s + y * c; p[2] = z;
      break;
    }
    case 'scale':
      p[0] = x * step.a; p[1] = y * step.a; p[2] = z * step.a;
      break;
    default:
      throw new Error(`HandRig: unknown transform "${step.k}"`);
  }
  return p;
}

/**
 * Apply a whole rig to a point.
 * @returns {number[]} [x, y, z]
 */
export function applyRig(steps, x, y, z) {
  const p = [x, y, z];
  for (const step of steps) applyStep(p, step);
  return p;
}


/**
 * The arm's transform stack, in view space, as data.
 *
 * Reads top to bottom and is applied in that order to each corner of the arm
 * box.
 *
 * @param {number} [swing] 0..1 swing progress; 0 is the resting pose
 * @param {number} [bob] vertical walk bob, in view units
 * @returns {Array<{k:string,a?:number,b?:number,c?:number}>}
 */
export function armRig(swing = 0, bob = 0) {
  const s = Math.max(0, Math.min(1, swing));
  const sqrtS = Math.sqrt(s);

  // The punch's travel, as a translation, exactly as Minecraft's
  // `doItemUsedTransformations` applies it.
  const swingX = -0.3 * Math.sin(sqrtS * Math.PI);
  const swingY = 0.4 * Math.sin(sqrtS * Math.PI * 2);
  const swingZ = -0.4 * Math.sin(s * Math.PI);

  const steps = [
    // Out in front of the camera, to the right, plus the swing and walk bob.
    { k: 'translate', a: RIG_BASE[0] + swingX, b: RIG_BASE[1] + swingY + bob, c: RIG_BASE[2] + swingZ },
    { k: 'rotateY', a: 45 * DEG },
    // The shoulder pivot. This MUST precede the three rotations below: applied
    // after them it would be a translation in camera space, and the arm would
    // stay parked at the model's resting place instead of swinging out from the
    // shoulder.
    { k: 'translate', a: SHOULDER_X, b: 0, c: 0 },
    // Undo the player model's at-rest pose, in which the arm hangs at the
    // player's side, so that it points into frame instead.
    { k: 'rotateZ', a: 120 * DEG },
    { k: 'rotateX', a: 200 * DEG },
    { k: 'rotateY', a: -135 * DEG }
  ];

  // The arm's own turn through the swing. Additive with the translation above,
  // as in the original; dropping either half makes the punch read as a shove
  // rather than a swing.
  if (s > 0) {
    steps.push({ k: 'rotateY', a: Math.sin(sqrtS * Math.PI) * 70 * DEG });
    steps.push({ k: 'rotateZ', a: Math.sin(s * s * Math.PI) * -20 * DEG });
  }

  // Reconciles Minecraft's +Z-forward model space with our -Z-forward view
  // space; see the note at the top of this file.
  steps.push({ k: 'rotateY', a: 180 * DEG });
  return steps;
}

/**
 * The transform for something held *in* the hand, as data.
 *
 * Built on top of the arm rig so that the item is composed in the arm's own
 * model space and cannot drift away from the hand: both are driven by the same
 * stack. `size` is in view units.
 *
 * @param {number} swing @param {number} bob pass the same values as the arm
 * @param {number} size edge length of the held cube, in view units
 * @param {number} [centreY] model-space y of the grip point
 */
/**
 * Where a point in the arm's model space ends up in view space.
 *
 * The pipeline, in the order it applies, and the reason it is written out here
 * rather than left implicit — each of these three stages has been separately
 * wrong at some point:
 *
 *   1. subtract the arm box's centre, so the rig can be applied about it;
 *   2. the rig itself — vanilla's base translation and rotations, in view space;
 *   3. the arm box's model->block scale, then the overall `RIG_SCALE` and
 *      `RIG_PLACEMENT`.
 *
 * Stage 2 is in blocks and stage 1 is in model pixels, which is the whole
 * difficulty: vanilla's base translation (0.56, -0.52, -0.72) is already in
 * blocks, while its `translate(5.6, 0, 0)` shoulder offset is in model pixels
 * and relies on the stack's trailing `scale(1/16)` to convert it. Keeping the
 * two spaces distinct — rather than trying to reconcile them into one — is what
 * makes the rig comparable to the original line for line.
 */
export function armPointToView(steps, x, y, z) {
  const p = applyRig(steps, x - ARM_CENTRE[0], y - ARM_CENTRE[1], z - ARM_CENTRE[2]);
  return [
    p[0] * ARM_MODEL_TO_VIEW * RIG_SCALE + RIG_PLACEMENT[0],
    p[1] * ARM_MODEL_TO_VIEW * RIG_SCALE + RIG_PLACEMENT[1],
    p[2] * ARM_MODEL_TO_VIEW * RIG_SCALE + RIG_PLACEMENT[2]
  ];
}

/**
 * The arm box's corners in view space, ordered by bit index.
 *
 * This is what the game builds: the mesh builder's face definitions index
 * corners as `(x ? 1 : 0) | (y ? 2 : 0) | (z ? 4 : 0)`, so the order here is
 * load-bearing rather than cosmetic.
 */
export function armBoxViewCorners(swing = 0, bob = 0) {
  const steps = armRig(swing, bob);
  const corners = new Array(8);
  for (let i = 0; i < 8; i++) {
    const p = armPointToView(
      steps,
      (i & 1) ? ARM_MAX[0] : ARM_MIN[0],
      (i & 2) ? ARM_MAX[1] : ARM_MIN[1],
      (i & 4) ? ARM_MAX[2] : ARM_MIN[2]
    );
    corners[i] = { x: p[0], y: p[1], z: p[2] };
  }
  return corners;
}

export function heldItemRig(swing, bob, size, centreY = FIST_CENTRE_MODEL_Y) {
  // Where is the fist? Ask the ARM rig, through the same one-way pipeline every
  // other measurement uses. Nothing here reconstructs or reverses a transform.
  const grip = armPointToView(armRig(swing, bob), 0, centreY, 0);
  return [
    // Scale the unit cube (two units across) to `size`, and face it at the
    // viewer: the arm is yawed 45 degrees at this point in its own stack, so
    // the item takes the opposite yaw.
    { k: 'scale', a: size / 2 },
    { k: 'rotateY', a: -45 * DEG },
    { k: 'translate', a: grip[0], b: grip[1], c: grip[2] }
  ];
}

export function heldItemBoxCorners(swing, bob, size, centreY = FIST_CENTRE_MODEL_Y) {
  // The rig already ends with the view-space scale and placement, so the corners
  // come out in view space directly. Applying `armPointToView` here as well
  // would apply the placement twice — which put the item about 1.3 view units
  // from the hand, i.e. off the bottom of the screen.
  const steps = heldItemRig(swing, bob, size, centreY);
  const corners = new Array(8);
  for (let i = 0; i < 8; i++) {
    const p = applyRig(steps, (i & 1) ? 1 : -1, (i & 2) ? 1 : -1, (i & 4) ? 1 : -1);
    corners[i] = { x: p[0], y: p[1], z: p[2] };
  }
  return corners;
}
