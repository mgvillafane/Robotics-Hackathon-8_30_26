import { Mesh, MeshPhongMaterial, type LoadingManager, type Material, type Object3D } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

/** urdf-loader's own callback signature. */
type MeshDone = (mesh: Object3D, error?: Error) => void;

/**
 * urdf-loader accepts a null mesh alongside an error at runtime, but its type
 * declaration requires an Object3D. This widens the callback for failure paths.
 */
type MeshFail = (mesh: null, error: Error) => void;

function fallbackMaterial(material: Material | null): Material {
  return material ?? new MeshPhongMaterial({ color: 0xbfc4cc, shininess: 24 });
}

/**
 * Mesh loader for URDF geometry.
 *
 * urdf-loader handles STL and Collada out of the box; OBJ and glTF are added
 * here because SO-ARM and other community URDFs ship a mix of formats.
 */
export function loadUrdfMesh(
  path: string,
  manager: LoadingManager,
  material: Material,
  done: MeshDone,
): void {
  const onError = (error: unknown) =>
    (done as unknown as MeshFail)(
      null,
      error instanceof Error ? error : new Error(String(error)),
    );

  if (/\.stl$/i.test(path)) {
    new STLLoader(manager).load(
      path,
      (geometry) => done(new Mesh(geometry, fallbackMaterial(material))),
      undefined,
      onError,
    );
    return;
  }

  if (/\.dae$/i.test(path)) {
    new ColladaLoader(manager).load(
      path,
      (collada) => {
        if (collada?.scene) done(collada.scene);
        else onError(new Error(`Collada file produced no scene: ${path}`));
      },
      undefined,
      onError,
    );
    return;
  }

  if (/\.(gltf|glb)$/i.test(path)) {
    new GLTFLoader(manager).load(path, (gltf) => done(gltf.scene), undefined, onError);
    return;
  }

  if (/\.obj$/i.test(path)) {
    new OBJLoader(manager).load(
      path,
      (group) => {
        if (material) {
          group.traverse((child) => {
            if ((child as Mesh).isMesh) (child as Mesh).material = material;
          });
        }
        done(group);
      },
      undefined,
      onError,
    );
    return;
  }

  onError(new Error(`Unsupported mesh format: ${path}`));
}
