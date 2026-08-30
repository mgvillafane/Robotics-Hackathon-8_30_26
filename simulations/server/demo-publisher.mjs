/**
 * Standalone demo stream.
 *
 * Serves a WebSocket endpoint that pushes a looping joint-state animation, so
 * the simulator can be exercised end to end without any robot or bridge:
 *
 *   npm run demo        then connect the app to ws://localhost:8765
 */
import { WebSocketServer } from 'ws';
import { poseAt } from './trajectory.mjs';

const PORT = Number(process.env.PORT ?? 8765);
const RATE_HZ = Number(process.env.RATE ?? 50);

const server = new WebSocketServer({ port: PORT });
const startedAt = Date.now();

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[demo] port ${PORT} is already in use. Stop the other process, or ` +
        `start this one on a different port with PORT=8766 npm run demo`,
    );
    process.exit(1);
  }
  throw error;
});

server.on('connection', (socket, request) => {
  const peer = request.socket.remoteAddress ?? 'unknown';
  console.log(`[demo] client connected from ${peer}`);
  socket.on('close', () => console.log(`[demo] client disconnected (${peer})`));
  socket.on('error', (error) => console.error(`[demo] socket error: ${error.message}`));
});

setInterval(() => {
  if (server.clients.size === 0) return;

  const t = (Date.now() - startedAt) / 1000;
  const message = JSON.stringify({
    robot: 'so101',
    unit: 'rad',
    timestamp: Date.now(),
    positions: poseAt(t),
  });

  for (const client of server.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}, 1000 / RATE_HZ);

console.log(`[demo] publishing joint states on ws://localhost:${PORT} at ${RATE_HZ} Hz`);
console.log('[demo] press Ctrl+C to stop');
