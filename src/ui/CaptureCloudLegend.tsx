import { useSimulatorStore } from '../state/store';

export function CaptureCloudLegend() {
  const cloud = useSimulatorStore((state) => state.captureCloud);
  const show = useSimulatorStore((state) => state.showCaptureCloud);
  if (!cloud || !show) return null;

  const left = cloud.points.some((point) => point.side === 'left');
  const right = cloud.points.some((point) => point.side === 'right');

  return (
    <div className="cloud-legend" aria-hidden="true">
      <strong>Capture points</strong>
      <span className="cloud-legend__row">
        {left && (
          <span>
            <i className="cloud-legend__swatch cloud-legend__swatch--left" />
            Left
          </span>
        )}
        {right && (
          <span>
            <i className="cloud-legend__swatch cloud-legend__swatch--right" />
            Right
          </span>
        )}
        <span>
          <i className="cloud-legend__swatch cloud-legend__swatch--now" />
          Now
        </span>
      </span>
    </div>
  );
}
