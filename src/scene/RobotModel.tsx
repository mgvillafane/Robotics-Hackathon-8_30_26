import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AxesHelper, Box3, Group, MeshStandardMaterial } from 'three';
import type { URDFRobot } from 'urdf-loader';
import type { RobotDefinition } from '../robots/types';
import { armBuses, type ArmBuses, type ArmSlot } from '../state/jointBus';
import { useSimulatorStore } from '../state/store';
import { diagnostics, type CollisionPair } from '../state/diagnostics';
import {
  applyHighlight,
  buildCollisionModel,
  detectCollisions,
  type CollisionModel,
} from './selfCollision';

interface RobotModelProps {
  definition: RobotDefinition;
  robot: URDFRobot;
  buses?: ArmBuses;
  slot?: ArmSlot;
  /** World-space base position. Dual-arm uses X as the shoulder line. */
  offset?: [number, number, number];
  /** Yaw about world Y, in radians. Dual-arm faces both grippers toward the camera. */
  yaw?: number;
}

const AXES_SIZE = 0.04;
const NO_LINKS: ReadonlySet<string> = new Set();

export function RobotModel({
  definition,
  robot,
  buses = armBuses.left,
  slot = 'left',
  offset = [0, 0, 0],
  yaw = 0,
}: RobotModelProps) {
  const groundedRef = useRef<Group>(null);
  const showJointAxes = useSimulatorStore((state) => state.showJointAxes);
  const setCollisionStatus = useSimulatorStore((state) => state.setCollisionStatus);
  const pushLog = useSimulatorStore((state) => state.pushLog);

  const collisionModel = useRef<CollisionModel | null>(null);
  const collisions = useRef<CollisionPair[]>([]);
  const lastSafePose = useRef<Record<string, number>>({});
  const highlighted = useRef<Set<string>>(new Set());
  const lastReportKey = useRef('');

  const highlightMaterial = useMemo(
    () =>
      new MeshStandardMaterial({
        color: '#ff4d4d',
        emissive: '#5c0000',
        emissiveIntensity: 0.8,
        roughness: 0.4,
      }),
    [],
  );
  useEffect(() => () => highlightMaterial.dispose(), [highlightMaterial]);

  // Drop the model onto the grid: URDF origins sit at the robot's base frame,
  // which is not always its lowest point.
  useLayoutEffect(() => {
    const group = groundedRef.current;
    if (!group) return;
    group.position.y = 0;
    group.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(group);
    if (Number.isFinite(box.min.y)) group.position.y = -box.min.y;
  }, [robot]);

  useEffect(() => {
    if (!showJointAxes) return;
    const helpers: Array<{ parent: Group; helper: AxesHelper }> = [];
    for (const joint of Object.values(robot.joints)) {
      const helper = new AxesHelper(AXES_SIZE);
      helper.renderOrder = 1;
      joint.add(helper);
      helpers.push({ parent: joint as unknown as Group, helper });
    }
    return () => {
      for (const { parent, helper } of helpers) {
        parent.remove(helper);
        helper.dispose();
      }
    };
  }, [robot, showJointAxes]);

  useEffect(() => {
    let cancelled = false;
    lastSafePose.current = {};
    highlighted.current.clear();
    lastReportKey.current = '';
    setCollisionStatus('building');

    // Building bounding volume hierarchies over ~320k triangles costs a few
    // hundred milliseconds, so let the robot paint first.
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      try {
        // The rest-pose surface test reads world coordinates, so make sure the
        // grounding offset above the robot is baked in before measuring.
        groundedRef.current?.updateWorldMatrix(true, true);
        const model = buildCollisionModel(robot);
        if (cancelled) {
          model.dispose();
          return;
        }
        collisionModel.current = model;
        if (slot === 'left') {
          setCollisionStatus('ready', {
            pairs: model.pairs.length,
            ignoredAlways: model.ignoredAlways.length,
            triangles: model.triangleCount,
            buildMs: model.buildMs,
          });
          // Naming the excluded pairs makes it obvious which links are being
          // watched, so a missing contact can be told from a filtered one.
          pushLog(
            'info',
            `Collision model: ${model.pairs.length} link pairs, ${model.groundLinks.length} vs surface` +
              (model.ignoredAlways.length > 0
                ? `; always overlapping: ${model.ignoredAlways
                    .map((pair) => `${pair.a}/${pair.b}`)
                    .join(', ')}`
                : ''),
          );
        }
      } catch (error) {
        if (slot === 'left') {
          setCollisionStatus('unavailable');
          pushLog('warn', `Self-collision checks unavailable: ${(error as Error).message}`);
        }
      }
    }, 50);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      collisionModel.current?.dispose();
      collisionModel.current = null;
    };
  }, [robot, slot, setCollisionStatus, pushLog]);

  useFrame((_state, delta) => {
    const { smoothing, checkSelfCollision, checkGroundCollision, blockSelfCollision } =
      useSimulatorStore.getState();
    // Time-constant easing, so the result does not depend on frame rate.
    const alpha = smoothing <= 0.001 ? 1 : 1 - Math.exp(-delta / smoothing);

    for (const joint of definition.joints) {
      const target = buses.target.get(joint.urdfName);
      const current = buses.displayed.get(joint.urdfName);
      const next = alpha >= 1 ? target : current + (target - current) * alpha;
      buses.displayed.set(joint.urdfName, next);
      robot.setJointValue(joint.urdfName, next);
    }

    const model = collisionModel.current;

    if (!checkSelfCollision || !model) {
      if (model && highlighted.current.size > 0) {
        applyHighlight(model, NO_LINKS, highlightMaterial);
        highlighted.current.clear();
      }
      if (lastReportKey.current !== '') {
        lastReportKey.current = '';
        diagnostics.setCollisions([], slot);
      }
      return;
    }

    // setJointValue only marks matrices dirty. The ground test works in world
    // space, so the ancestors carrying the grounding offset must be current
    // too, not just the robot's own subtree.
    groundedRef.current?.updateWorldMatrix(true, true);

    const startedAt = performance.now();
    const hits = detectCollisions(model, collisions.current, checkGroundCollision);
    diagnostics.setCheckCost(performance.now() - startedAt);

    if (hits.length === 0) {
      const safe = lastSafePose.current;
      for (const joint of definition.joints) {
        safe[joint.urdfName] = buses.displayed.get(joint.urdfName);
      }
    } else if (blockSelfCollision) {
      // Rewind to the last good pose before this frame reaches the screen.
      // The reported collision stays as-is: it describes the pose that was
      // commanded, which is what the operator needs to see.
      const safe = lastSafePose.current;
      let restored = false;
      for (const joint of definition.joints) {
        const value = safe[joint.urdfName];
        if (value === undefined) continue;
        buses.displayed.set(joint.urdfName, value);
        robot.setJointValue(joint.urdfName, value);
        restored = true;
      }
      if (restored) {
        groundedRef.current?.updateWorldMatrix(true, true);
        diagnostics.noteBlocked();
      }
    }

    const key = hits.map((pair) => `${pair.a}~${pair.b}`).join(',');
    if (key !== lastReportKey.current) {
      lastReportKey.current = key;
      diagnostics.setCollisions(hits, slot);

      highlighted.current.clear();
      for (const pair of hits) {
        highlighted.current.add(pair.a);
        highlighted.current.add(pair.b);
      }
      applyHighlight(model, highlighted.current, highlightMaterial);
    }
  });

  return (
    <group position={offset} rotation={[0, yaw, 0]}>
      <group ref={groundedRef}>
        <group
          rotation={definition.upAxis === 'Z' ? [-Math.PI / 2, 0, 0] : [0, 0, 0]}
          scale={definition.scale}
        >
          <primitive object={robot} />
        </group>
      </group>
    </group>
  );
}
