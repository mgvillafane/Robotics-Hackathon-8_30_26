import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Line as ThreeLine,
  LineBasicMaterial,
  LineSegments,
  Points,
  PointsMaterial,
} from 'three';
import {
  cloudKey,
  cloudTimeAtProgress,
  type CaptureCloud as CaptureCloudData,
  type CloudPoint,
} from '../io/captureCloud';
import { workspaceForApproach } from '../io/so101Ik';
import { useSimulatorStore } from '../state/store';
import type { ArmSlot } from '../state/jointBus';
import { placeUrdfPoint } from './staging';

const LEFT = new Color('#3f8ecc');
const RIGHT = new Color('#d2542c');
const INDEX = new Color('#f4d35e');

const HAND_BONES: Array<[string, string]> = [
  ['wrist', 'thumb'],
  ['wrist', 'index_mcp'],
  ['index_mcp', 'index'],
  ['wrist', 'middle_mcp'],
  ['middle_mcp', 'middle_tip'],
];

const POSE_BONES: Array<[string, string]> = [
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'right_shoulder'],
  ['left_hip', 'right_hip'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
];

function mixToward(base: Color, toward: Color, amount: number): Color {
  const color = base.clone();
  color.lerp(toward, amount);
  return color;
}

function currentByName(points: CloudPoint[], now: number): Map<string, CloudPoint> {
  const latest = new Map<string, CloudPoint>();
  for (const point of points) {
    if (cloudKey(point) > now) continue;
    const previous = latest.get(point.name);
    if (!previous || cloudKey(point) >= cloudKey(previous)) latest.set(point.name, point);
  }
  return latest;
}

function WorkspaceBox({
  slot,
  dualArm,
  approach,
}: {
  slot: ArmSlot;
  dualArm: boolean;
  approach: number;
}) {
  const corners = useMemo(() => {
    const box = workspaceForApproach(approach);
    const xs = box.x;
    const ys = box.y;
    const zs = box.z;
    const raw: Array<[number, number, number]> = [];
    for (const x of xs) for (const y of ys) for (const z of zs) raw.push([x, y, z]);
    return raw.map(([x, y, z]) => placeUrdfPoint({ x, y, z }, slot, dualArm, approach));
  }, [slot, dualArm, approach]);

  const geometry = useMemo(() => {
    const edges = [
      [0, 1], [2, 3], [4, 5], [6, 7],
      [0, 2], [1, 3], [4, 6], [5, 7],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const positions = new Float32Array(edges.length * 6);
    edges.forEach(([a, b], i) => {
      positions.set(corners[a], i * 6);
      positions.set(corners[b], i * 6 + 3);
    });
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    return geo;
  }, [corners]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial
        color={slot === 'left' ? LEFT : RIGHT}
        transparent
        opacity={0.28}
      />
    </lineSegments>
  );
}

function HistoryPoints({
  points,
  dualArm,
  approach,
}: {
  points: CloudPoint[];
  dualArm: boolean;
  approach: number;
}) {
  const { geometry, material } = useMemo(() => {
    const history = points.filter((point) => point.name === 'index');
    const positions = new Float32Array(history.length * 3);
    const colors = new Float32Array(history.length * 3);
    const white = new Color('#ffffff');
    history.forEach((point, i) => {
      const [x, y, z] = placeUrdfPoint(point, point.side, dualArm, approach);
      positions.set([x, y, z], i * 3);
      const base = point.name === 'index' || point.name.endsWith('wrist')
        ? mixToward(point.side === 'left' ? LEFT : RIGHT, INDEX, point.name === 'index' ? 0.45 : 0)
        : point.side === 'left' ? LEFT : RIGHT;
      const tinted = mixToward(base, white, 0.15);
      colors.set([tinted.r, tinted.g, tinted.b], i * 3);
    });
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('color', new BufferAttribute(colors, 3));
    const mat = new PointsMaterial({
      size: 0.007,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      sizeAttenuation: true,
    });
    return { geometry: geo, material: mat };
  }, [points, dualArm, approach]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  return <points geometry={geometry} material={material} />;
}

function IndexTrail({
  points,
  side,
  dualArm,
  approach,
}: {
  points: CloudPoint[];
  side: ArmSlot;
  dualArm: boolean;
  approach: number;
}) {
  const object = useMemo(() => {
    const tips = points
      .filter((point) => point.side === side && point.name === 'index')
      .sort((a, b) => cloudKey(a) - cloudKey(b));
    if (tips.length < 2) return null;
    const stride = Math.max(1, Math.floor(tips.length / 1500));
    const sampled = tips.filter((_, i) => i % stride === 0 || i === tips.length - 1);
    const positions = new Float32Array(sampled.length * 3);
    sampled.forEach((point, i) => {
      positions.set(placeUrdfPoint(point, side, dualArm, approach), i * 3);
    });
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    const mat = new LineBasicMaterial({
      color: side === 'left' ? LEFT : RIGHT,
      transparent: true,
      opacity: 0.7,
    });
    return new ThreeLine(geo, mat);
  }, [points, side, dualArm, approach]);

  useEffect(
    () => () => {
      if (!object) return;
      object.geometry.dispose();
      const material = object.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material.dispose();
    },
    [object],
  );
  if (!object) return null;
  return <primitive object={object} />;
}

function CurrentPose({
  cloud,
  dualArm,
  approach,
}: {
  cloud: CaptureCloudData;
  dualArm: boolean;
  approach: number;
}) {
  const spheres = useRef<Points | null>(null);
  const bones = useRef<LineSegments | null>(null);
  const sphereMat = useMemo(
    () =>
      new PointsMaterial({
        size: 0.016,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        sizeAttenuation: true,
        depthWrite: false,
      }),
    [],
  );
  const boneMat = useMemo(
    () => new LineBasicMaterial({ color: '#f4d35e', transparent: true, opacity: 0.9 }),
    [],
  );

  const sphereGeom = useMemo(() => {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(24 * 3), 3));
    geo.setAttribute('color', new BufferAttribute(new Float32Array(24 * 3), 3));
    geo.setDrawRange(0, 0);
    return geo;
  }, []);

  const boneGeom = useMemo(() => {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(32 * 2 * 3), 3));
    geo.setDrawRange(0, 0);
    return geo;
  }, []);

  useEffect(
    () => () => {
      sphereMat.dispose();
      boneMat.dispose();
      sphereGeom.dispose();
      boneGeom.dispose();
    },
    [sphereMat, boneMat, sphereGeom, boneGeom],
  );

  useFrame(() => {
    const progress = useSimulatorStore.getState().playbackProgress;
    const now = cloudTimeAtProgress(cloud, progress);
    const bonesSpec = cloud.kind === 'hand' ? HAND_BONES : POSE_BONES;
    const pos = sphereGeom.getAttribute('position') as BufferAttribute;
    const col = sphereGeom.getAttribute('color') as BufferAttribute;
    const bonePos = boneGeom.getAttribute('position') as BufferAttribute;

    let sphereCount = 0;
    let boneCount = 0;
    for (const side of ['left', 'right'] as const) {
      const latest = currentByName(
        cloud.points.filter((point) => point.side === side),
        now,
      );
      const color = side === 'left' ? LEFT : RIGHT;
      for (const point of latest.values()) {
        if (sphereCount >= 24) break;
        const [x, y, z] = placeUrdfPoint(point, side, dualArm, approach);
        pos.setXYZ(sphereCount, x, y, z);
        const highlight = point.name === 'index' || point.name.endsWith('wrist');
        col.setXYZ(
          sphereCount,
          highlight ? INDEX.r : color.r,
          highlight ? INDEX.g : color.g,
          highlight ? INDEX.b : color.b,
        );
        sphereCount += 1;
      }
      for (const [a, b] of bonesSpec) {
        const pa = latest.get(a);
        const pb = latest.get(b);
        if (!pa || !pb) continue;
        const from = placeUrdfPoint(pa, pa.side, dualArm, approach);
        const to = placeUrdfPoint(pb, pb.side, dualArm, approach);
        bonePos.setXYZ(boneCount, from[0], from[1], from[2]);
        bonePos.setXYZ(boneCount + 1, to[0], to[1], to[2]);
        boneCount += 2;
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    bonePos.needsUpdate = true;
    sphereGeom.setDrawRange(0, sphereCount);
    boneGeom.setDrawRange(0, boneCount);
    sphereGeom.computeBoundingSphere();
  });

  return (
    <>
      <points ref={spheres} geometry={sphereGeom} material={sphereMat} />
      <lineSegments ref={bones} geometry={boneGeom} material={boneMat} />
    </>
  );
}

export function CaptureCloudPlot() {
  const cloud = useSimulatorStore((state) => state.captureCloud);
  const show = useSimulatorStore((state) => state.showCaptureCloud);
  const dualArm = useSimulatorStore((state) => state.dualArm);
  const approach = useSimulatorStore((state) => state.workspaceApproach);

  if (!cloud || !show || cloud.points.length === 0) return null;

  const sides = new Set(cloud.points.map((point) => point.side));

  return (
    <group>
      {sides.has('left') && <WorkspaceBox slot="left" dualArm={dualArm} approach={approach} />}
      {sides.has('right') && <WorkspaceBox slot="right" dualArm={dualArm} approach={approach} />}
      <HistoryPoints points={cloud.points} dualArm={dualArm} approach={approach} />
      <IndexTrail points={cloud.points} side="left" dualArm={dualArm} approach={approach} />
      <IndexTrail points={cloud.points} side="right" dualArm={dualArm} approach={approach} />
      <CurrentPose cloud={cloud} dualArm={dualArm} approach={approach} />
    </group>
  );
}
