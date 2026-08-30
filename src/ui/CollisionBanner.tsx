import { useDiagnostics } from '../hooks/useDiagnostics';
import { GROUND } from '../scene/selfCollision';
import { useSimulatorStore } from '../state/store';

function linkLabel(name: string): string {
  if (name === GROUND) return name;
  return name.replace(/_link$/, '').replace(/_/g, ' ');
}

/** Floating alert over the viewport while links are intersecting. */
export function CollisionBanner() {
  const checkSelfCollision = useSimulatorStore((state) => state.checkSelfCollision);
  const { collisions, blocking } = useDiagnostics();

  if (!checkSelfCollision || collisions.length === 0) return null;

  const onlySurface = collisions.every((pair) => pair.b === GROUND);
  const kind = onlySurface ? 'surface contact' : 'self-collision';

  return (
    <div className="collision-banner" role="alert">
      <span className="collision-banner__dot" aria-hidden="true" />
      <div>
        <strong>{blocking ? `Motion blocked \u2014 ${kind}` : kind}</strong>
        <span className="collision-banner__pairs">
          {collisions.map((pair) => `${linkLabel(pair.a)} \u2194 ${linkLabel(pair.b)}`).join(' \u00b7 ')}
        </span>
      </div>
    </div>
  );
}
