import { useEffect } from 'react';
import { getRobot } from './robots/registry';
import { useSimulatorStore } from './state/store';
import { useJointStream } from './hooks/useJointStream';
import { useUrdfRobot } from './scene/useUrdfRobot';
import { SimulatorScene } from './scene/SimulatorScene';
import { RobotSelector } from './ui/RobotSelector';
import { SourcePanel } from './ui/SourcePanel';
import { JointControls } from './ui/JointControls';
import { SafetyPanel } from './ui/SafetyPanel';
import { CollisionBanner } from './ui/CollisionBanner';
import { ViewOptions } from './ui/ViewOptions';
import { LogPanel } from './ui/LogPanel';
import { StatusBar } from './ui/StatusBar';
import { AssetNotice } from './ui/AssetNotice';

export default function App() {
  const robotId = useSimulatorStore((state) => state.robotId);
  const setUrdfLimits = useSimulatorStore((state) => state.setUrdfLimits);
  const setUrdfReady = useSimulatorStore((state) => state.setUrdfReady);
  const setUrdfError = useSimulatorStore((state) => state.setUrdfError);
  const pushLog = useSimulatorStore((state) => state.pushLog);

  const definition = getRobot(robotId);
  if (!definition) throw new Error(`Unknown robot "${robotId}".`);

  const urdf = useUrdfRobot(definition);
  useJointStream(definition);

  useEffect(() => {
    if (urdf.status === 'ready') {
      setUrdfLimits(urdf.limits);
      setUrdfReady(true);
      pushLog('info', `Loaded ${definition.name} model.`);
    } else if (urdf.status === 'error') {
      setUrdfError(urdf.error);
      pushLog('warn', `${definition.name}: ${urdf.error}`);
    }
  }, [
    urdf.status,
    urdf.limits,
    urdf.error,
    definition,
    setUrdfLimits,
    setUrdfReady,
    setUrdfError,
    pushLog,
  ]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          Arm Simulator
          <span className="topbar__sub">joint-state driven visualiser</span>
        </h1>
      </header>

      <div className="app__body">
        <aside className="sidebar">
          <RobotSelector />
          <SourcePanel definition={definition} />
          <JointControls definition={definition} />
          <SafetyPanel />
          <ViewOptions />
          <LogPanel />
        </aside>

        <main className="viewport">
          <SimulatorScene definition={definition} urdf={urdf} />
          <div className="viewport__overlay">
            <AssetNotice definition={definition} urdf={urdf} />
          </div>
          <CollisionBanner />
        </main>
      </div>

      <StatusBar definition={definition} urdf={urdf} />
    </div>
  );
}
