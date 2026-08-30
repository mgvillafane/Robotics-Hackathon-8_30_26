/**
 * Position-only inverse kinematics for the SO-101.
 *
 * The real URDF has five revolute joints plus a gripper. This solver treats
 * the first three as a pan + 2-link planar arm and holds the wrist straight,
 * which is enough to put a point (the tracked index tip) in space. Wrist roll
 * and the gripper are left to the caller.
 *
 * Link lengths are the joint-origin distances from so101_new_calib.urdf, with
 * a short extra on L2 so the target is the fingertip rather than the roll axis.
 * Signs were chosen so a target in front of the base (URDF +X, +Z up) produces
 * a reachable, elbow-down pose inside the published limits.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface IkSolution {
  shoulder_pan: number;
  shoulder_lift: number;
  elbow_flex: number;
  /** False when the target was clamped onto the reachable sphere. */
  reachable: boolean;
}

export interface FoldedIkSolution extends IkSolution {
  wrist_flex: number;
}

export interface JointLimit {
  lower: number;
  upper: number;
}

export type IkLimits = Partial<Record<'shoulder_pan' | 'shoulder_lift' | 'elbow_flex', JointLimit>>;

/** Shoulder pivot height and the two pitching links, in metres. */
const SHOULDER = { x: 0.0388, y: 0, z: 0.0624 };
const L1 = 0.116;
const L2 = 0.22;

const DEFAULT_LIMITS: Record<'shoulder_pan' | 'shoulder_lift' | 'elbow_flex', JointLimit> = {
  shoulder_pan: { lower: -1.91986, upper: 1.91986 },
  shoulder_lift: { lower: -1.74533, upper: 1.74533 },
  elbow_flex: { lower: -1.69, upper: 1.69 },
};

/**
 * The box we map a capture's index cloud into. Kept inside the thinner
 * shell that the elbow limits actually allow (about 24–33 cm from the
 * shoulder), not just the geometric 2-link sphere.
 */
export type WorkspaceBox = {
  x: [number, number];
  y: [number, number];
  z: [number, number];
};

export const SO101_WORKSPACE: WorkspaceBox = {
  x: [0.28, 0.34],
  y: [-0.07, 0.07],
  z: [0.08, 0.17],
};

/** Folded end of the approach slider — still inside the elbow-limited shell. */
const SO101_WORKSPACE_NEAR: WorkspaceBox = {
  x: [0.255, 0.305],
  y: [-0.06, 0.06],
  z: [0.09, 0.15],
};

function lerpPair(from: [number, number], to: [number, number], t: number): [number, number] {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

/**
 * Slides the IK workspace from the stretched default toward the shoulder as
 * `approach` increases. Subtracting reach after mapping used to put targets
 * inside the minimum sphere, and the solver then pushed them back out — so
 * the joints never changed. Remapping the box keeps every target in-band.
 */
export function workspaceForApproach(approach: number, maxApproach = 0.1): WorkspaceBox {
  const t = clamp(approach / Math.max(1e-6, maxApproach), 0, 1);
  return {
    x: lerpPair(SO101_WORKSPACE.x, SO101_WORKSPACE_NEAR.x, t),
    y: lerpPair(SO101_WORKSPACE.y, SO101_WORKSPACE_NEAR.y, t),
    z: lerpPair(SO101_WORKSPACE.z, SO101_WORKSPACE_NEAR.z, t),
  };
}

function distanceForElbow(elbow: number): number {
  return Math.sqrt(L1 * L1 + L2 * L2 + 2 * L1 * L2 * Math.cos(elbow));
}

/** Reachable |target − shoulder| given the elbow travel, in metres. */
function reachBand(elbowLimit: JointLimit): [number, number] {
  const samples = [elbowLimit.lower, elbowLimit.upper];
  if (elbowLimit.lower <= 0 && elbowLimit.upper >= 0) samples.push(0);
  const distances = samples.map(distanceForElbow);
  return [Math.min(...distances) + 1e-4, Math.max(...distances) - 1e-4];
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function clampJoint(value: number, limit: JointLimit): number {
  return clamp(value, limit.lower, limit.upper);
}

/** Forward kinematics of the 3-DOF model, URDF frame (Z up). */
export function so101Fk(pan: number, lift: number, elbow: number): Vec3 {
  const horiz = L1 * Math.cos(lift) + L2 * Math.cos(lift + elbow);
  const vert = L1 * Math.sin(lift) + L2 * Math.sin(lift + elbow);
  const heading = Math.cos(pan);
  const side = Math.sin(pan);
  return {
    x: SHOULDER.x + horiz * heading,
    y: SHOULDER.y + horiz * side,
    z: SHOULDER.z + vert,
  };
}

/**
 * Analytic IK. Two elbow configurations are tried (down, then up); the first
 * that lands inside the joint limits wins. Targets outside the reachable
 * sphere are scaled onto it and marked `reachable: false`.
 */
export function solveSo101Ik(target: Vec3, limits: IkLimits = {}): IkSolution {
  const panLimit = limits.shoulder_pan ?? DEFAULT_LIMITS.shoulder_pan;
  const liftLimit = limits.shoulder_lift ?? DEFAULT_LIMITS.shoulder_lift;
  const elbowLimit = limits.elbow_flex ?? DEFAULT_LIMITS.elbow_flex;

  const pan = clampJoint(Math.atan2(target.y - SHOULDER.y, target.x - SHOULDER.x), panLimit);

  const dx = target.x - SHOULDER.x;
  const dy = target.y - SHOULDER.y;
  let horiz = Math.hypot(dx, dy);
  let vert = target.z - SHOULDER.z;

  const [minReach, maxReach] = reachBand(elbowLimit);
  let d = Math.hypot(horiz, vert);
  let reachable = true;
  if (d < 1e-6) {
    horiz = minReach;
    vert = 0;
    d = minReach;
    reachable = false;
  } else if (d < minReach || d > maxReach) {
    const scale = clamp(d, minReach, maxReach) / d;
    horiz *= scale;
    vert *= scale;
    d = Math.hypot(horiz, vert);
    reachable = false;
  }

  const cosElbow = clamp((d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1);
  const elbowMag = Math.acos(cosElbow);
  const elevation = Math.atan2(vert, horiz);
  const liftFor = (elbow: number) =>
    elevation - Math.atan2(L2 * Math.sin(elbow), L1 + L2 * Math.cos(elbow));

  const candidates: Array<[number, number]> = [
    [liftFor(-elbowMag), -elbowMag],
    [liftFor(elbowMag), elbowMag],
  ];
  // Prefer the more folded elbow so the forearm does not spear through the cloud.
  candidates.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  for (const [lift, elbow] of candidates) {
    const liftOk = lift >= liftLimit.lower && lift <= liftLimit.upper;
    const elbowOk = elbow >= elbowLimit.lower && elbow <= elbowLimit.upper;
    if (liftOk && elbowOk) {
      return { shoulder_pan: pan, shoulder_lift: lift, elbow_flex: elbow, reachable };
    }
  }

  const [lift, elbow] = candidates[0];
  return {
    shoulder_pan: pan,
    shoulder_lift: clampJoint(lift, liftLimit),
    elbow_flex: clampJoint(elbow, elbowLimit),
    reachable: false,
  };
}

/**
 * Bends the elbow and tucks the wrist as Approach increases. The 3-DOF reach
 * band is too thin to fold the arm by moving the target alone; this is the
 * extra articulation that keeps the forearm from passing through the points.
 */
export function applyApproachFold(
  solution: IkSolution,
  approach: number,
  limits: IkLimits = {},
  maxApproach = 0.1,
): FoldedIkSolution {
  const fold = clamp(approach / Math.max(1e-6, maxApproach), 0, 1);
  const elbowLimit = limits.elbow_flex ?? DEFAULT_LIMITS.elbow_flex;
  const liftLimit = limits.shoulder_lift ?? DEFAULT_LIMITS.shoulder_lift;
  const wristLimit = { lower: -1.65806, upper: 1.65806 };
  const sign = solution.elbow_flex >= 0 ? 1 : -1;
  return {
    shoulder_pan: solution.shoulder_pan,
    shoulder_lift: clampJoint(solution.shoulder_lift + fold * 0.3, liftLimit),
    elbow_flex: clampJoint(solution.elbow_flex + sign * fold * 1.25, elbowLimit),
    wrist_flex: clampJoint(-sign * fold * 1.15, wristLimit),
    reachable: solution.reachable,
  };
}

export function percentileRange(values: number[], low = 0.02, high = 0.98): [number, number] {
  if (values.length === 0) return [0, 1];
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  const a = at(low);
  const b = at(high);
  return a === b ? [a - 0.05, b + 0.05] : [a, b];
}

/** Linear map from one interval onto another, clamped. */
export function mapInterval(value: number, from: [number, number], to: [number, number]): number {
  const t = (value - from[0]) / (from[1] - from[0]);
  return to[0] + clamp(t, 0, 1) * (to[1] - to[0]);
}

/**
 * Sends a MediaPipe Hands landmark into the robot workspace.
 *
 * Image X (right) → robot Y, image Y (down) → robot −Z (height), landmark Z
 * (wrist-relative depth) → robot X (reach). Each axis is fitted to the
 * capture's own range so a hand that only moved a little still spans the box.
 */
export function landmarkToWorkspace(
  landmark: Vec3,
  observed: { x: [number, number]; y: [number, number]; z: [number, number] },
  workspace = SO101_WORKSPACE,
): Vec3 {
  return {
    x: mapInterval(landmark.z, observed.z, workspace.x),
    y: mapInterval(landmark.x, observed.x, workspace.y),
    z: mapInterval(landmark.y, observed.y, [workspace.z[1], workspace.z[0]]),
  };
}
