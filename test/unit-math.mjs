/**
 * unit-math.mjs — pure-function checks on the first-person rig.
 *
 * No browser and no server: this runs in milliseconds, and it exists to pin
 * behaviour that cost real debugging time. Every assertion is in VIEW space,
 * because the first-person rig is drawn with the camera's projection and no
 * view matrix — the camera sits at the origin and nothing world-space is
 * involved.
 *
 * The rig is a list of point transforms rather than a matrix chain, which
 * removes a whole class of silent error (see the notes in `HandRig.js`): a
 * transform is a function from a point to a point, so there is no operand order
 * to reverse and nothing to alias. What is left to check is the ORDER of the
 * steps and the overall placement, and that is what follows.
 */
import {
  applyRig, armRig, heldItemRig, armBoxViewCorners, heldItemBoxCorners,
  ARM_MIN, ARM_MAX, ARM_CENTRE, FIST_CENTRE_MODEL_Y, MODEL_PIXELS_PER_UNIT,
  ARM_MODEL_TO_VIEW, RIG_SCALE, RIG_PLACEMENT
} from '../src/render/HandRig.js';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const D = Math.PI / 180;
const W = 1280, H = 720;
const TAN_HALF = Math.tan(72 * D / 2);
const close = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;
const fmt = (p) => `(${p.map((n) => n.toFixed(3)).join(', ')})`;

/** Project a view-space point the way the renderer's shader does. */
function project(p) {
  const depth = -p[2];
  return {
    x: (p[0] / (depth * TAN_HALF * (W / H)) * 0.5 + 0.5) * W,
    y: (0.5 - p[1] / (depth * TAN_HALF) * 0.5) * H,
    depth
  };
}

// ---------------------------------------------------------------------------
console.log('\nThe transform steps');
// ---------------------------------------------------------------------------
{
  // A rotation must actually rotate. If `applyStep` silently no-ops, every
  // downstream measurement still looks like a plausible arm.
  const y = applyRig([{ k: 'rotateY', a: 90 * D }], 1, 0, 0);
  check('rotateY(90) maps +X to -Z', close(y[0], 0) && close(y[2], -1), `-> ${fmt(y)}`);

  const z = applyRig([{ k: 'rotateZ', a: 90 * D }], 1, 0, 0);
  check('rotateZ(90) maps +X to +Y', close(z[0], 0) && close(z[1], 1), `-> ${fmt(z)}`);

  const x = applyRig([{ k: 'rotateX', a: 90 * D }], 0, 1, 0);
  check('rotateX(90) maps +Y to +Z', close(x[1], 0) && close(x[2], 1), `-> ${fmt(x)}`);

  // Order: a translate before a rotation is carried by that rotation; after it,
  // it is not. This is the difference between an arm that swings from the
  // shoulder and one that sits where the model left it.
  const before = applyRig([{ k: 'translate', a: 5, b: 0, c: 0 }, { k: 'rotateY', a: 90 * D }], 0, 0, 0);
  const after = applyRig([{ k: 'rotateY', a: 90 * D }, { k: 'translate', a: 5, b: 0, c: 0 }], 0, 0, 0);
  check('translate-then-rotate carries the translation',
    close(before[2], -5) && close(after[0], 5),
    `before ${fmt(before)}, after ${fmt(after)}`);
}

// ---------------------------------------------------------------------------
console.log('\nThe arm rig');
// ---------------------------------------------------------------------------
{
  const steps = armRig(0, 0);
  const corners = armBoxViewCorners(0, 0);
  check('the arm is one box, eight corners', corners.length === 8, `${corners.length} corners`);

  // The shoulder and hand centres, in view space. The rig is applied to points
  // relative to the arm box's centre, then scaled and placed — the same three
  // stages `armBoxViewCorners` uses, so this doubles as a check on it.
  const toView = (y) => {
    const p = applyRig(steps, -ARM_CENTRE[0], y - ARM_CENTRE[1], -ARM_CENTRE[2]);
    return p.map((n, i) => n * ARM_MODEL_TO_VIEW * RIG_SCALE + RIG_PLACEMENT[i]);
  };
  const s = toView(0), h = toView(-12);

  // The arm is 12 model pixels long: 12/16 = 0.75 view units, times the rig
  // scale. If the steps are applied in the wrong order the box collapses.
  const span = Math.hypot(h[0] - s[0], h[1] - s[1], h[2] - s[2]);
  check('the arm keeps its length',
    close(span, 0.75 * RIG_SCALE, 0.01),
    `shoulder-to-hand span ${span.toFixed(3)}, expected ${(0.75 * RIG_SCALE).toFixed(3)}`);

  check('the whole arm is in front of the camera',
    corners.every((c) => c.z < -0.15),
    `nearest corner at depth ${Math.min(...corners.map((c) => -c.z)).toFixed(3)}`);

  const pts = corners.map((c) => project([c.x, c.y, c.z]));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const onScreenW = Math.min(W, Math.max(...xs)) - Math.max(0, Math.min(...xs));
  const onScreenH = Math.min(H, Math.max(...ys)) - Math.max(0, Math.min(...ys));

  check('the arm is cropped by the right edge', Math.max(...xs) > W,
    `rightmost point at x=${Math.max(...xs).toFixed(0)} of ${W}`);
  check('the arm is cropped by the bottom edge', Math.max(...ys) > H,
    `lowest point at y=${Math.max(...ys).toFixed(0)} of ${H}`);
  check('the visible arm sits in the bottom-right corner',
    Math.min(...xs) > 0.6 * W && Math.min(...ys) > 0.3 * H,
    `visible from (${Math.min(...xs).toFixed(0)}, ${Math.min(...ys).toFixed(0)})`);

  // Measured off a vanilla first-person frame: the visible hand is about
  // 128x160 px. Allow generous slack — this guards against a re-tune that
  // doubles the arm or shrinks it to a speck, not against a few percent.
  check('the visible arm is hand-sized, not frame-sized',
    onScreenW > 90 && onScreenW < 340 && onScreenH > 90 && onScreenH < 420,
    `visible ${onScreenW.toFixed(0)}x${onScreenH.toFixed(0)} px`);
}

// ---------------------------------------------------------------------------
console.log('\nMotion');
// ---------------------------------------------------------------------------
{
  const spanOf = (swing, bob) => {
    const steps = armRig(swing, bob);
    const a = applyRig(steps, -ARM_CENTRE[0], 0 - ARM_CENTRE[1], -ARM_CENTRE[2]);
    const b = applyRig(steps, -ARM_CENTRE[0], -12 - ARM_CENTRE[1], -ARM_CENTRE[2]);
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * ARM_MODEL_TO_VIEW;
  };
  const travel = (swing) => {
    const rest = armBoxViewCorners(0, 0);
    const m = armBoxViewCorners(swing, 0);
    return Math.hypot(m[0].x - rest[0].x, m[0].y - rest[0].y, m[0].z - rest[0].z);
  };

  check('the arm stays rigid through the swing',
    close(spanOf(0, 0), spanOf(1, 0), 1e-6) && close(spanOf(0, 0), spanOf(0.5, 0), 1e-6),
    `span ${spanOf(0, 0).toFixed(4)} / ${spanOf(0.5, 0).toFixed(4)} / ${spanOf(1, 0).toFixed(4)}`);
  // The swing is a full out-and-back cycle, exactly as vanilla's f1/f3 pair is:
  // it peaks in the middle and returns to the resting pose at the end. Checking
  // only the endpoint would pass for a swing that never moves at all.
  check('the swing moves the hand and returns it',
    travel(0.25) > 0.03 && travel(0.5) > 0.05 && travel(1) < 0.01,
    `travel ${travel(0.25).toFixed(3)} at quarter, ${travel(0.5).toFixed(3)} at half, ${travel(1).toFixed(3)} at full`);
  check('the walk bob moves the arm without deforming it',
    close(spanOf(0, 0.05), spanOf(0, 0), 1e-6),
    `span with bob ${spanOf(0, 0.05).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log('\nThe held item');
// ---------------------------------------------------------------------------
{
  const size = 0.22;
  const corners = heldItemBoxCorners(0, 0, size);
  const edge = Math.hypot(
    corners[1].x - corners[0].x, corners[1].y - corners[0].y, corners[1].z - corners[0].z);

  // Measure an EDGE, not the bounding box: the cube is yawed, so its axis-aligned
  // extent is wider than its side and would overstate the size by ~57%.
  check('the held item is the size it was asked for',
    close(edge, size, 0.005),
    `edge ${edge.toFixed(3)}, asked for ${size}`);

  check('the held item is in front of the camera',
    corners.every((c) => c.z < 0),
    `nearest ${Math.min(...corners.map((c) => -c.z)).toFixed(3)}`);

  // The item must ride the hand: same grip point, so it cannot drift away when
  // the arm swings.
  const gripAt = (swing) => {
    const steps = armRig(swing, 0);
    const p = applyRig(steps, -ARM_CENTRE[0], FIST_CENTRE_MODEL_Y - ARM_CENTRE[1], -ARM_CENTRE[2]);
    return p.map((n, i) => n * ARM_MODEL_TO_VIEW * RIG_SCALE + RIG_PLACEMENT[i]);
  };
  const centre = (swing) => {
    const c = heldItemBoxCorners(swing, 0, size);
    return [0, 1, 2].map((k) => c.reduce((sum, p) => sum + [p.x, p.y, p.z][k], 0) / 8);
  };
  const gapAt = (swing) => {
    const g = gripAt(swing), c = centre(swing);
    return Math.hypot(c[0] - g[0], c[1] - g[1], c[2] - g[2]);
  };
  check('the held item sits on the grip point',
    gapAt(0) < 0.06,
    `item centre is ${gapAt(0).toFixed(4)} from the grip`);
  check('the held item stays on the grip point through the swing',
    Math.abs(gapAt(1) - gapAt(0)) < 0.01,
    `gap ${gapAt(0).toFixed(4)} at rest, ${gapAt(1).toFixed(4)} at full swing`);
}

// ---------------------------------------------------------------------------
console.log('\nUnit bookkeeping');
// ---------------------------------------------------------------------------
{
  check('the arm box is 4x12x4 model pixels',
    ARM_MAX[0] - ARM_MIN[0] === 4 && ARM_MAX[1] - ARM_MIN[1] === 12 && ARM_MAX[2] - ARM_MIN[2] === 4,
    `${ARM_MAX[0] - ARM_MIN[0]} x ${ARM_MAX[1] - ARM_MIN[1]} x ${ARM_MAX[2] - ARM_MIN[2]}`);
  check('model pixels convert to view units at 1/16',
    close(ARM_MODEL_TO_VIEW, 1 / MODEL_PIXELS_PER_UNIT),
    `${ARM_MODEL_TO_VIEW} vs 1/${MODEL_PIXELS_PER_UNIT}`);
  // The bug this guards: vanilla's 0.56/-0.52/-0.72 base translation is in
  // BLOCKS while the 5.6 shoulder offset is in MODEL PIXELS. Mixing them puts
  // the shoulder 5.6 blocks in front of the camera and the arm entirely off the
  // bottom of the frame.
  const raw = armBoxViewCorners(0, 0);
  check('no corner is absurdly far from the camera',
    raw.every((c) => Math.abs(c.z) < 4 && Math.abs(c.x) < 3 && Math.abs(c.y) < 3),
    `corner extremes x ${Math.min(...raw.map(c=>c.x)).toFixed(2)}..${Math.max(...raw.map(c=>c.x)).toFixed(2)}, ` +
    `z ${Math.min(...raw.map(c=>c.z)).toFixed(2)}..${Math.max(...raw.map(c=>c.z)).toFixed(2)}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
  process.exit(1);
}
