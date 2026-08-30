import { useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { ContactShadows, Grid, GizmoHelper, GizmoViewport, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { RobotDefinition } from '../robots/types';
import { useSimulatorStore } from '../state/store';
import type { UrdfState } from './useUrdfRobot';
import { RobotModel } from './RobotModel';
import { PlaceholderArm } from './PlaceholderArm';

interface SimulatorSceneProps {
  definition: RobotDefinition;
  urdf: UrdfState;
}

/** Light studio backdrop. The SO-101's yellow and black read well against it. */
const BACKGROUND = '#eceff4';
const GRID_CELL = '#d2d8e0';
const GRID_SECTION = '#a9b3c1';

/** Re-frames the camera whenever a different robot is selected. */
function CameraRig({ definition }: { definition: RobotDefinition }) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as OrbitControlsImpl | null;

  useEffect(() => {
    const [x, y, z] = definition.camera.position;
    camera.position.set(x, y, z);
    if (controls) {
      const [tx, ty, tz] = definition.camera.target;
      controls.target.set(tx, ty, tz);
      controls.update();
    }
  }, [camera, controls, definition]);

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

export function SimulatorScene({ definition, urdf }: SimulatorSceneProps) {
  const showGrid = useSimulatorStore((state) => state.showGrid);
  const controlsRef = useRef<OrbitControlsImpl>(null);

  return (
    <Canvas
      // PCFSoft is deprecated in current three; percentage maps to PCFShadowMap.
      shadows="percentage"
      dpr={[1, 2]}
      camera={{
        position: definition.camera.position,
        fov: 42,
        near: 0.01,
        far: 100,
      }}
      gl={{ antialias: true }}
    >
      <color attach="background" args={[BACKGROUND]} />
      <fog attach="fog" args={[BACKGROUND, 3, 12]} />

      <Lighting />

      {urdf.robot ? (
        <RobotModel definition={definition} robot={urdf.robot} />
      ) : (
        <PlaceholderArm definition={definition} />
      )}

      <ContactShadows
        position={[0, 0.001, 0]}
        opacity={0.38}
        scale={2}
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
        target={definition.camera.target}
        enableDamping
        dampingFactor={0.08}
        minDistance={0.12}
        maxDistance={4}
        maxPolarAngle={Math.PI / 2 - 0.02}
      />
      <CameraRig definition={definition} />

      <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
        <GizmoViewport
          axisColors={['#d2542c', '#5da84e', '#3f8ecc']}
          labelColor="#ffffff"
        />
      </GizmoHelper>
    </Canvas>
  );
}
