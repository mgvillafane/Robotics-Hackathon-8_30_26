import type { RobotDefinition } from '../robots/types';
import type { UrdfState } from '../scene/useUrdfRobot';

/**
 * Explains how to install a robot's meshes when the URDF could not be loaded.
 * The simulator stays usable in the meantime via the placeholder model.
 */
export function AssetNotice({
  definition,
  urdf,
}: {
  definition: RobotDefinition;
  urdf: UrdfState;
}) {
  if (urdf.status !== 'error' && urdf.missingMeshes.length === 0) return null;

  if (urdf.status === 'error') {
    return (
      <div className="notice">
        <h3>Showing a placeholder for {definition.name}</h3>
        <p className="notice__error">{urdf.error}</p>
        <p>
          Joint streaming and every control still work &mdash; the schematic arm moves with your
          data until the real model is installed.
        </p>
        <ol>
          {definition.assets.instructions.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="muted">
          Source:{' '}
          <a href={definition.assets.sourceUrl} target="_blank" rel="noreferrer">
            {definition.assets.sourceUrl}
          </a>{' '}
          ({definition.assets.license})
        </p>
      </div>
    );
  }

  return (
    <div className="notice notice--warn">
      <h3>{urdf.missingMeshes.length} mesh file(s) failed to load</h3>
      <p>The model is rendered without them. Check these paths:</p>
      <ul>
        {urdf.missingMeshes.slice(0, 6).map((url) => (
          <li key={url}>
            <code>{url}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
