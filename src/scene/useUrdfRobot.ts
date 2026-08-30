import { useEffect, useState } from 'react';
import { LoaderUtils, LoadingManager, Mesh, Material } from 'three';
import URDFLoader, { type URDFRobot } from 'urdf-loader';
import type { RobotDefinition } from '../robots/types';
import type { JointLimits } from '../io/parse';
import { loadUrdfMesh } from './meshLoader';

export type UrdfStatus = 'loading' | 'ready' | 'error';

export interface UrdfState {
  robot: URDFRobot | null;
  status: UrdfStatus;
  /** Populated when the URDF could not be fetched, is empty, or is malformed. */
  error: string;
  /** Mesh URLs that failed to load. The robot still renders without them. */
  missingMeshes: string[];
  /** Limits read from the URDF, keyed by joint name. */
  limits: JointLimits;
}

const INITIAL: UrdfState = {
  robot: null,
  status: 'loading',
  error: '',
  missingMeshes: [],
  limits: {},
};

function readLimits(robot: URDFRobot): JointLimits {
  const limits: JointLimits = {};
  for (const [name, joint] of Object.entries(robot.joints)) {
    // Continuous joints report lower === upper === 0; leave them out so the
    // definition's fallback range is used instead.
    if (joint.limit && joint.limit.upper > joint.limit.lower) {
      limits[name] = { lower: joint.limit.lower, upper: joint.limit.upper };
    }
  }
  return limits;
}

function disposeRobot(robot: URDFRobot): void {
  robot.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((entry: Material) => entry.dispose());
    else material?.dispose();
  });
}

/**
 * Fetches and parses a robot's URDF, including its meshes.
 *
 * The file is fetched and checked here rather than handed straight to
 * urdf-loader, because the loader throws an opaque type error on anything that
 * is not a well-formed URDF. Distinguishing "not added yet" from "empty" from
 * "malformed" is what makes the missing-asset panel useful.
 */
export function useUrdfRobot(definition: RobotDefinition): UrdfState {
  const [state, setState] = useState<UrdfState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    let robot: URDFRobot | null = null;
    let parsed = false;
    let pendingMeshes = 0;
    const missing: string[] = [];
    const controller = new AbortController();

    setState(INITIAL);

    const fail = (message: string) => {
      if (cancelled) return;
      setState({ ...INITIAL, status: 'error', error: message });
    };

    const finishIfSettled = () => {
      if (cancelled || !parsed || pendingMeshes > 0) return;
      setState((previous) =>
        previous.robot
          ? { ...previous, status: 'ready', missingMeshes: [...missing] }
          : previous,
      );
    };

    const run = async () => {
      const { urdfUrl } = definition;
      let text: string;

      try {
        const response = await fetch(urdfUrl, { signal: controller.signal });
        if (!response.ok) {
          fail(`No URDF at ${urdfUrl} (HTTP ${response.status}).`);
          return;
        }
        text = await response.text();
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        fail(`Could not fetch ${urdfUrl}: ${(error as Error).message}`);
        return;
      }

      if (cancelled) return;

      if (text.trim().length === 0) {
        fail(`${urdfUrl} is empty. Paste the URDF into public${urdfUrl}.`);
        return;
      }

      // The dev server answers unknown paths with the app's own HTML and a 200,
      // so a wrong urdfUrl arrives here rather than as a 404.
      if (/^\s*<(!doctype html|html[\s>])/i.test(text)) {
        fail(`Nothing at ${urdfUrl} \u2014 the server returned the app page. Check the path.`);
        return;
      }

      if (!/<\s*robot[\s>]/i.test(text)) {
        fail(`${urdfUrl} has no <robot> element, so it is not a URDF.`);
        return;
      }

      const manager = new LoadingManager();
      const loader = new URDFLoader(manager);
      loader.workingPath = LoaderUtils.extractUrlBase(urdfUrl);
      if (definition.packages) loader.packages = definition.packages;

      // Counting meshes here is more reliable than LoadingManager.onLoad, which
      // never fires for a URDF built entirely from primitive shapes.
      loader.loadMeshCb = (path, meshManager, material, done) => {
        pendingMeshes += 1;
        loadUrdfMesh(path, meshManager, material, (mesh, error) => {
          if (error && !missing.includes(path)) missing.push(path);
          pendingMeshes -= 1;
          done(mesh, error);
          finishIfSettled();
        });
      };

      try {
        robot = loader.parse(text);
      } catch (error) {
        fail(`Could not parse ${urdfUrl}: ${(error as Error).message}`);
        return;
      }

      if (cancelled) {
        disposeRobot(robot);
        robot = null;
        return;
      }

      parsed = true;
      setState({
        robot,
        status: pendingMeshes > 0 ? 'loading' : 'ready',
        error: '',
        missingMeshes: [...missing],
        limits: readLimits(robot),
      });
    };

    void run();

    return () => {
      cancelled = true;
      controller.abort();
      if (robot) disposeRobot(robot);
    };
  }, [definition]);

  return state;
}
