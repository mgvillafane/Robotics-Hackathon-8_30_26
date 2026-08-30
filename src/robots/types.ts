/**
 * Units a joint-state producer might send. Everything is converted to radians
 * before it reaches the renderer.
 *
 * - `rad`     raw radians (what the URDF expects)
 * - `deg`     degrees
 * - `norm100` LeRobot's normalised range, where -100..100 maps onto the joint's
 *             full travel and the gripper uses 0..100
 */
export type AngleUnit = 'rad' | 'deg' | 'norm100';

export interface JointDefinition {
  /** Joint name exactly as it appears in the URDF. */
  urdfName: string;
  /**
   * Key this joint arrives under in an incoming payload. For LeRobot arms this
   * matches the `observation.state` feature name.
   */
  streamKey: string;
  /** Short label for the UI. */
  label: string;
  /**
   * Fallback travel limits in radians. Limits parsed from the URDF at load time
   * take priority; these only apply when the URDF omits them (e.g. continuous
   * joints) or before the model has loaded.
   */
  lower: number;
  upper: number;
  /** Flip direction when the hardware's positive rotation opposes the URDF's. */
  invert?: boolean;
  /** Constant offset in radians applied after unit conversion and inversion. */
  offset?: number;
  /**
   * Input range this joint uses under the `norm100` unit. LeRobot normalises
   * rotational joints to -100..100 but the gripper to 0..100.
   */
  normalizedRange?: [number, number];
  /**
   * Reinterprets the frame's unit for this joint alone.
   *
   * LeRobot reports mixed units: with `use_degrees` on (the default since
   * v0.6.0) the five arm joints are degrees while the gripper stays on its
   * 0..100 scale. Mapping `deg -> norm100` on the gripper keeps a single
   * incoming frame correct for every joint.
   */
  unitAliases?: Partial<Record<AngleUnit, AngleUnit>>;
}

/**
 * One link of the stand-in arm drawn when a robot's URDF is not installed yet.
 * Segments form a serial chain, each rotating about `axis` in its parent's
 * frame and extending `length` metres along +Y.
 */
export interface PlaceholderSegment {
  /** URDF joint name whose value drives this segment. */
  joint: string;
  axis: 'x' | 'y' | 'z';
  length: number;
  radius?: number;
  /** Draw two fingers that separate as the joint value grows. */
  gripper?: boolean;
}

export interface RobotDefinition {
  /** Stable identifier used in URLs, stream payloads and the registry. */
  id: string;
  name: string;
  vendor: string;
  description: string;
  /** URDF location, served from `public/`. */
  urdfUrl: string;
  /**
   * Resolves `package://<name>/...` mesh references inside the URDF to a URL
   * prefix. Most SO-ARM URDFs use relative mesh paths and need no entry here.
   */
  packages?: Record<string, string>;
  /** Unit incoming joint states use unless a payload overrides it. */
  streamUnit: AngleUnit;
  /** Ordered joints. The order defines the array layout for array payloads. */
  joints: JointDefinition[];
  /** Up axis of the URDF. Nearly all URDFs are Z-up; the scene is Y-up. */
  upAxis: 'Y' | 'Z';
  /** Uniform scale applied to the loaded model. */
  scale: number;
  /** Initial camera framing, in metres. */
  camera: {
    position: [number, number, number];
    target: [number, number, number];
  };
  /**
   * Rough proportions used to render a stand-in arm until the real meshes are
   * installed. Optional; without it, missing assets show an empty scene.
   */
  placeholder?: PlaceholderSegment[];
  /** Where to obtain the URDF and meshes, shown in-app when assets are absent. */
  assets: {
    sourceUrl: string;
    license: string;
    /** Human-readable install steps rendered in the missing-asset panel. */
    instructions: string[];
  };
}
