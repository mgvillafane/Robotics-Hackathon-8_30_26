import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group, Mesh } from 'three';
import type { PlaceholderSegment, RobotDefinition } from '../robots/types';
import { displayedJoints, targetJoints } from '../state/jointBus';
import { useSimulatorStore } from '../state/store';

const LINK_COLOR = '#5b6472';
const ACCENT_COLOR = '#e0653a';
const JOINT_COLOR = '#2c313a';

/** Eases the displayed value toward the target, matching RobotModel's feel. */
function useEasedJoint(name: string) {
  return (delta: number): number => {
    const { smoothing } = useSimulatorStore.getState();
    const alpha = smoothing <= 0.001 ? 1 : 1 - Math.exp(-delta / smoothing);
    const target = targetJoints.get(name);
    const current = displayedJoints.get(name);
    const next = alpha >= 1 ? target : current + (target - current) * alpha;
    displayedJoints.set(name, next);
    return next;
  };
}

function Finger({ segment, side }: { segment: PlaceholderSegment; side: 1 | -1 }) {
  const ref = useRef<Mesh>(null);

  useFrame(() => {
    // The parent Segment owns the easing; this only reads the result.
    const value = displayedJoints.get(segment.joint);
    // Treat the joint value as a half-opening angle mapped to a lateral offset.
    const spread = 0.008 + Math.max(0, value) * 0.022;
    if (ref.current) ref.current.position.x = side * spread;
  });

  return (
    <mesh ref={ref} position={[side * 0.01, segment.length / 2, 0]} castShadow>
      <boxGeometry args={[0.008, segment.length, 0.018]} />
      <meshStandardMaterial color={ACCENT_COLOR} roughness={0.5} metalness={0.1} />
    </mesh>
  );
}

function Segment({
  segments,
  index,
}: {
  segments: PlaceholderSegment[];
  index: number;
}) {
  const segment = segments[index];
  const ref = useRef<Group>(null);
  const ease = useEasedJoint(segment.joint);

  useFrame((_state, delta) => {
    const value = ease(delta);
    // The gripper opens its fingers rather than rotating the whole link.
    if (ref.current && !segment.gripper) ref.current.rotation[segment.axis] = value;
  });

  const radius = segment.radius ?? 0.018;
  const next = segments[index + 1];

  return (
    <group ref={ref}>
      <mesh position={[0, 0, 0]} castShadow>
        <sphereGeometry args={[radius * 1.15, 20, 14]} />
        <meshStandardMaterial color={JOINT_COLOR} roughness={0.45} metalness={0.25} />
      </mesh>

      {segment.gripper ? (
        <>
          <Finger segment={segment} side={1} />
          <Finger segment={segment} side={-1} />
        </>
      ) : (
        <mesh position={[0, segment.length / 2, 0]} castShadow>
          <boxGeometry args={[radius * 1.6, segment.length, radius * 1.6]} />
          <meshStandardMaterial color={LINK_COLOR} roughness={0.55} metalness={0.15} />
        </mesh>
      )}

      {next && (
        <group position={[0, segment.length, 0]}>
          <Segment segments={segments} index={index + 1} />
        </group>
      )}
    </group>
  );
}

/**
 * A schematic arm rendered in place of the real model. It is driven by the same
 * joint bus as the URDF robot, so the full input pipeline can be tested before
 * any meshes are installed.
 */
export function PlaceholderArm({ definition }: { definition: RobotDefinition }) {
  const segments = definition.placeholder;
  if (!segments || segments.length === 0) return null;

  return (
    <group>
      <mesh position={[0, 0.008, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[0.055, 0.065, 0.016, 32]} />
        <meshStandardMaterial color={JOINT_COLOR} roughness={0.6} metalness={0.2} />
      </mesh>
      <group position={[0, 0.016, 0]}>
        <Segment segments={segments} index={0} />
      </group>
    </group>
  );
}
