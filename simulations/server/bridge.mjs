/**
 * Joint-state relay.
 *
 * Producers that cannot easily host a WebSocket server (a Python control loop,
 * a ROS node, a notebook) push frames in over HTTP; the browser subscribes over
 * WebSocket on the same port.
 *
 *   npm run bridge
 *   POST http://localhost:8765/joint_states   with a JSON frame as the body
 *   ws://localhost:8765                       receives every frame
 *
 * WebSocket clients may also publish: anything they send is relayed to the
 * other subscribers.
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8765);
const MAX_BODY_BYTES = 1 << 20;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

let framesRelayed = 0;

const server = http.createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS_HEADERS).end();
    return;
  }

  if (request.method === 'GET' && request.url === '/health') {
    response
      .writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS })
      .end(JSON.stringify({ ok: true, subscribers: wss.clients.size, framesRelayed }));
    return;
  }

  if (request.method !== 'POST' || !request.url?.startsWith('/joint_states')) {
    response.writeHead(404, CORS_HEADERS).end('Not found');
    return;
  }

  let body = '';
  let aborted = false;

  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      aborted = true;
      response.writeHead(413, CORS_HEADERS).end('Payload too large');
      request.destroy();
    }
  });

  request.on('end', () => {
    if (aborted) return;
    try {
      // Validate before relaying so bad payloads fail at the producer, not in
      // the browser.
      JSON.parse(body);
    } catch {
      response.writeHead(400, CORS_HEADERS).end('Body must be JSON');
      return;
    }
    broadcast(body, null);
    response.writeHead(204, CORS_HEADERS).end();
  });
});

const wss = new WebSocketServer({ server });

function broadcast(message, sender) {
  framesRelayed += 1;
  for (const client of wss.clients) {
    if (client !== sender && client.readyState === client.OPEN) client.send(message);
  }
}

wss.on('connection', (socket, request) => {
  const peer = request.socket.remoteAddress ?? 'unknown';
  console.log(`[bridge] subscriber connected from ${peer} (${wss.clients.size} total)`);

  socket.on('message', (data) => broadcast(data.toString(), socket));
  socket.on('error', (error) => console.error(`[bridge] socket error: ${error.message}`));
  socket.on('close', () =>
    console.log(`[bridge] subscriber left (${wss.clients.size} remaining)`),
  );
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[bridge] port ${PORT} is already in use. Stop the other process, or ` +
        `start this one on a different port with PORT=8766 npm run bridge`,
    );
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, () => {
  console.log(`[bridge] websocket  ws://localhost:${PORT}`);
  console.log(`[bridge] ingest     POST http://localhost:${PORT}/joint_states`);
  console.log(`[bridge] health     GET  http://localhost:${PORT}/health`);
});
