import { useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { ContactShadows, Grid, GizmoHelper, GizmoViewport, Html, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { RobotDefinition } from '../robots/types';
import { armBuses } from '../state/jointBus';
import { useSimulatorStore } from '../state/store';
import type { UrdfState } from './useUrdfRobot';
import { RobotModel } from './RobotModel';
import { PlaceholderArm } from './PlaceholderArm';
import { CaptureCloudPlot } from './CaptureCloud';
import { DUAL_CAMERA, addOffset, approachWorldDelta, armPose } from './staging';

interface SimulatorSceneProps {
  definition: RobotDefinition;
  urdf: UrdfState;
}

/** Light studio backdrop. The SO-101's yellow and black read well against it. */
const BACKGROUND = '#eceff4';
const GRID_CELL = '#d2d8e0';
const GRID_SECTION = '#a9b3c1';

/** Re-frames the camera whenever a different robot is selected or a second arm appears. */
function CameraRig({
  definition,
  dualArm,
}: {
  definition: RobotDefinition;
  dualArm: boolean;
}) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as OrbitControlsImpl | null;

  useEffect(() => {
    const [x, y, z] = dualArm ? DUAL_CAMERA.position : definition.camera.position;
    camera.position.set(x, y, z);
    if (controls) {
      const [tx, ty, tz] = dualArm ? DUAL_CAMERA.target : definition.camera.target;
      controls.target.set(tx, ty, tz);
      controls.update();
    }
  }, [camera, controls, definition, dualArm]);

  return null;
}

function Lighting() {
  return (
    <>
      {/* Ground tone is light too, so upward-facing surfaces pick up bounce
          from the backdrop rather than going muddy. */}
      <hemisphereLight args={['#ffffff', '#c6ccd6', 1.5]} />
      <directionalLight
        position={[1.2, 1.8, 1.0]}
        intensity={1.7}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-1}
        shadow-camera-right={1}
        shadow-camera-top={1}
        shadow-camera-bottom={-1}
        shadow-camera-near={0.1}
        shadow-camera-far={6}
        shadow-bias={-0.0005}
      />
      <directionalLight position={[-1.4, 0.9, -1.1]} intensity={0.35} />
    </>
  );
}

function ArmLabel({ label, position }: { label: string; position: [number, number, number] }) {
  return (
    <Html position={position} center distanceFactor={2.4} style={{ pointerEvents: 'none' }}>
      <div className="arm-label">{label}</div>
    </Html>
  );
}

export function SimulatorScene({ definition, urdf }: SimulatorSceneProps) {
  const showGrid = useSimulatorStore((state) => state.showGrid);
  const dualArm = useSimulatorStore((state) => state.dualArm);
  const workspaceApproach = useSimulatorStore((state) => state.workspaceApproach);
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const leftRobot = urdf.robots[0] ?? urdf.robot;
  const rightRobot = urdf.robots[1] ?? null;
  const cameraPosition = dualArm ? DUAL_CAMERA.position : definition.camera.position;
  const leftPose = armPose('left', dualArm);
  const rightPose = armPose('right', dualArm);
  const leftOffset = addOffset(leftPose.offset, approachWorldDelta(leftPose.yaw, workspaceApproach));
  const rightOffset = addOffset(rightPose.offset, approachWorldDelta(rightPose.yaw, workspaceApproach));

  return (
    <Canvas
      // PCFSoft is deprecated in current three; percentage maps to PCFShadowMap.
      shadows="percentage"
      dpr={[1, 2]}
      camera={{
        position: cameraPosition,
        fov: dualArm ? 46 : 42,
        near: 0.01,
        far: 100,
      }}
      gl={{ antialias: true }}
    >
      <color attach="background" args={[BACKGROUND]} />
      <fog attach="fog" args={[BACKGROUND, 3, 12]} />

      <Lighting />

      {leftRobot ? (
        <RobotModel
          definition={definition}
          robot={leftRobot}
          buses={armBuses.left}
          slot="left"
          offset={leftOffset}
          yaw={leftPose.yaw}
        />
      ) : (
        <PlaceholderArm
          definition={definition}
          buses={armBuses.left}
          offset={leftOffset}
          yaw={leftPose.yaw}
        />
      )}

      {dualArm &&
        (rightRobot ? (
          <RobotModel
            definition={definition}
            robot={rightRobot}
            buses={armBuses.right}
            slot="right"
            offset={rightOffset}
            yaw={rightPose.yaw}
          />
        ) : (
          <PlaceholderArm
            definition={definition}
            buses={armBuses.right}
            offset={rightOffset}
            yaw={rightPose.yaw}
          />
        ))}

      {dualArm && (
        <>
          <ArmLabel label="Right" position={[rightOffset[0], 0.32, rightOffset[2]]} />
          <ArmLabel label="Left" position={[leftOffset[0], 0.32, leftOffset[2]]} />
        </>
      )}

      <CaptureCloudPlot />

      <ContactShadows
        position={[0, 0.001, 0]}
        opacity={0.38}
        scale={dualArm ? 3.2 : 2}
        blur={2.4}
        far={0.8}
        resolution={1024}
        color="#1c2028"
      />

      {showGrid && (
        <Grid
          args={[10, 10]}
          cellSize={0.05}
          cellThickness={0.6}
          cellColor={GRID_CELL}
          sectionSize={0.25}
          sectionThickness={1.1}
          sectionColor={GRID_SECTION}
          fadeDistance={7}
          fadeStrength={1.2}
          infiniteGrid
        />
      )}

      <OrbitControls
        ref={controlsRef}
        makeDefault
        target={dualArm ? DUAL_CAMERA.target : definition.camera.target}
        enableDamping
        dampingFactor={0.08}
        minDistance={0.12}
        maxDistance={4}
        maxPolarAngle={Math.PI / 2 - 0.02}
      />
      <CameraRig definition={definition} dualArm={dualArm} />

      <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
        <GizmoViewport
          axisColors={['#d2542c', '#5da84e', '#3f8ecc']}
          labelColor="#ffffff"
        />
      </GizmoHelper>
    </Canvas>
  );
}
