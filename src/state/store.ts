import { create } from 'zustand';
import { DEFAULT_ROBOT_ID, getRobot } from '../robots/registry';
import type { RobotDefinition } from '../robots/types';
import { resolveLimits, type JointLimits } from '../io/parse';
import type { SourceKind, SourceStatus } from '../io/types';
import type { CaptureCloud } from '../io/captureCloud';
import { armBuses, resetArmBuses, type ArmSlot } from './jointBus';
import { diagnostics } from './diagnostics';

const MAX_LOG_ENTRIES = 50;

export interface LogEntry {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

export type CollisionStatus = 'idle' | 'building' | 'ready' | 'unavailable';

export interface CollisionStats {
  /** Link pairs actually tested each frame. */
  pairs: number;
  /** Pairs excluded because they overlap even at the zero pose. */
  ignoredAlways: number;
  triangles: number;
  buildMs: number;
}

interface SimulatorState {
  robotId: string;
  sourceKind: SourceKind;
  status: SourceStatus;
  statusDetail: string;
  websocketUrl: string;
  /** Limits in use, seeded from the definition and refined by the URDF. */
  limits: JointLimits;
  urdfReady: boolean;
  urdfError: string;
  /** 0 disables easing; higher values track the target more slowly. */
  smoothing: number;
  showGrid: boolean;
  showJointAxes: boolean;
  /** Plot uploaded pose/hand landmarks in the robot workspace. */
  showCaptureCloud: boolean;
  captureCloud: CaptureCloud | null;
  /** Playback head, 0..1, used to highlight the current capture frame. */
  playbackProgress: number;
  /**
   * Metres the bases slide toward the capture cloud along each arm's reach.
   * IK targets are pulled in by the same amount so the pose stays reachable.
   */
  workspaceApproach: number;
  /** Run self-collision queries each frame. */
  checkSelfCollision: boolean;
  /** Also test links against the surface the robot is mounted on. */
  checkGroundCollision: boolean;
  /** Hold the arm at its last collision-free pose instead of only reporting. */
  blockSelfCollision: boolean;
  collisionStatus: CollisionStatus;
  collisionStats: CollisionStats | null;
  /** Second copy of the same robot, driven by the opposite hand/arm. */
  dualArm: boolean;
  /** Which arm the joint sliders write to when both are on stage. */
  activeArm: ArmSlot;
  log: LogEntry[];

  robot: () => RobotDefinition;
  selectRobot: (id: string) => void;
  setSourceKind: (kind: SourceKind) => void;
  setStatus: (status: SourceStatus, detail?: string) => void;
  setWebsocketUrl: (url: string) => void;
  setUrdfLimits: (limits: JointLimits) => void;
  setUrdfReady: (ready: boolean) => void;
  setUrdfError: (message: string) => void;
  setSmoothing: (value: number) => void;
  toggleGrid: () => void;
  toggleJointAxes: () => void;
  toggleCaptureCloud: () => void;
  setCaptureCloud: (cloud: CaptureCloud | null) => void;
  setPlaybackProgress: (progress: number) => void;
  setWorkspaceApproach: (metres: number) => void;
  toggleSelfCollision: () => void;
  toggleGroundCollision: () => void;
  toggleBlockSelfCollision: () => void;
  setCollisionStatus: (status: CollisionStatus, stats?: CollisionStats) => void;
  toggleDualArm: () => void;
  setDualArm: (enabled: boolean) => void;
  setActiveArm: (slot: ArmSlot) => void;
  pushLog: (level: LogEntry['level'], message: string) => void;
  clearLog: () => void;
  homeRobot: () => void;
}

function definitionFor(id: string): RobotDefinition {
  const robot = getRobot(id);
  if (!robot) throw new Error(`Unknown robot "${id}".`);
  return robot;
}

let logId = 0;

export const useSimulatorStore = create<SimulatorState>((set, get) => ({
  robotId: DEFAULT_ROBOT_ID,
  sourceKind: 'manual',
  status: 'idle',
  statusDetail: '',
  websocketUrl: 'ws://localhost:8765',
  limits: resolveLimits(definitionFor(DEFAULT_ROBOT_ID)),
  urdfReady: false,
  urdfError: '',
  smoothing: 0.25,
  showGrid: true,
  showJointAxes: false,
  showCaptureCloud: true,
  captureCloud: null,
  playbackProgress: 0,
  workspaceApproach: 0.05,
  checkSelfCollision: true,
  checkGroundCollision: true,
  blockSelfCollision: false,
  collisionStatus: 'idle',
  collisionStats: null,
  dualArm: false,
  activeArm: 'left',
  log: [],

  robot: () => definitionFor(get().robotId),

  selectRobot: (id) => {
    if (id === get().robotId) return;
    const robot = definitionFor(id);
    resetArmBuses();
    diagnostics.reset();
    set({
      robotId: id,
      limits: resolveLimits(robot),
      urdfReady: false,
      urdfError: '',
      status: 'idle',
      statusDetail: '',
      collisionStatus: 'idle',
      collisionStats: null,
      captureCloud: null,
      playbackProgress: 0,
    });
  },

  setSourceKind: (kind) => set({ sourceKind: kind, status: 'idle', statusDetail: '' }),

  setStatus: (status, detail = '') => set({ status, statusDetail: detail }),

  setWebsocketUrl: (url) => set({ websocketUrl: url }),

  setUrdfLimits: (limits) => set({ limits: resolveLimits(definitionFor(get().robotId), limits) }),

  setUrdfReady: (ready) => set({ urdfReady: ready, ...(ready ? { urdfError: '' } : {}) }),

  setUrdfError: (message) => set({ urdfError: message, urdfReady: false }),

  setSmoothing: (value) => set({ smoothing: Math.min(0.95, Math.max(0, value)) }),

  toggleGrid: () => set((state) => ({ showGrid: !state.showGrid })),

  toggleJointAxes: () => set((state) => ({ showJointAxes: !state.showJointAxes })),

  toggleCaptureCloud: () => set((state) => ({ showCaptureCloud: !state.showCaptureCloud })),

  setCaptureCloud: (cloud) => set({ captureCloud: cloud }),

  setPlaybackProgress: (progress) =>
    set({ playbackProgress: Math.min(1, Math.max(0, progress)) }),

  setWorkspaceApproach: (metres) =>
    set({ workspaceApproach: Math.min(0.1, Math.max(0, metres)) }),

  toggleSelfCollision: () =>
    set((state) => {
      const checkSelfCollision = !state.checkSelfCollision;
      diagnostics.setCollisions([]);
      // Blocking without detection is meaningless, so it follows suit.
      return {
        checkSelfCollision,
        blockSelfCollision: checkSelfCollision && state.blockSelfCollision,
      };
    }),

  toggleGroundCollision: () =>
    set((state) => {
      diagnostics.setCollisions([]);
      return { checkGroundCollision: !state.checkGroundCollision };
    }),

  toggleBlockSelfCollision: () =>
    set((state) =>
      state.checkSelfCollision ? { blockSelfCollision: !state.blockSelfCollision } : state,
    ),

  setCollisionStatus: (status, stats) =>
    set({ collisionStatus: status, ...(stats !== undefined ? { collisionStats: stats } : {}) }),

  toggleDualArm: () => get().setDualArm(!get().dualArm),

  setDualArm: (enabled) =>
    set((state) => {
      if (state.dualArm === enabled) return state;
      if (!enabled) {
        armBuses.right.target.reset();
        armBuses.right.displayed.reset();
        diagnostics.clearSlot('right');
      }
      return { dualArm: enabled, activeArm: enabled ? state.activeArm : 'left' };
    }),

  setActiveArm: (slot) => set({ activeArm: slot }),

  pushLog: (level, message) =>
    set((state) => {
      const last = state.log[0];
      // Collapse repeats so a failing stream cannot flood the panel.
      if (last && last.message === message && last.level === level) return state;
      const entry: LogEntry = { id: (logId += 1), level, message, at: Date.now() };
      return { log: [entry, ...state.log].slice(0, MAX_LOG_ENTRIES) };
    }),

  clearLog: () => set({ log: [] }),

  homeRobot: () => {
    const robot = definitionFor(get().robotId);
    const home: Record<string, number> = {};
    for (const joint of robot.joints) home[joint.urdfName] = 0;
    armBuses.left.target.reset(home);
    if (get().dualArm) armBuses.right.target.reset({ ...home });
  },
}));
