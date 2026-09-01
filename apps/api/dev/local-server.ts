/**
 * The local inner loop for `apps/api`, per `../../../CLAUDE.md`
 * (**Local-first development**): it needs no Vercel CLI, no Vercel account and
 * no network. Node 24 strips TypeScript types natively, so this file runs
 * under plain `node --watch` with nothing installed.
 *
 * It mounts the very same exported handler the deployed function uses, so a
 * behaviour observed here is a behaviour of the real route rather than of a
 * second, drifting implementation of it.
 *
 * Never deployed. Vercel captures a Node server entrypoint only from
 * `server.*` at the project root or in `src/`; a file named `local-server.ts`
 * under `dev/` matches neither, and only files under `api/` become functions.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { GET } from '../api/health.ts';

const DEFAULT_PORT = 3001;
const HEALTH_PATH = '/api/health';

/**
 * The deployed runtime hands the handler a web `Request`; `node:http` deals in
 * `IncomingMessage`. Translating here keeps that difference out of the route.
 * The health route reads no body, so none is forwarded -- adding one would be
 * untested surface in a file that exists only to serve a GET.
 */
function toWebRequest(incoming: IncomingMessage): Request {
  const host = incoming.headers.host ?? `localhost:${DEFAULT_PORT}`;
  const url = new URL(incoming.url ?? '/', `http://${host}`);

  return new Request(url, { method: incoming.method ?? 'GET' });
}

async function writeWebResponse(
  outgoing: ServerResponse,
  response: Response,
): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(await response.text());
}

function notFound(): Response {
  return new Response(JSON.stringify({ status: 'not_found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

const server = createServer((incoming, outgoing) => {
  const request = toWebRequest(incoming);
  const path = new URL(request.url).pathname;
  const response =
    request.method === 'GET' && path === HEALTH_PATH ? GET(request) : notFound();

  // A rejection here would otherwise take the whole dev server down as an
  // unhandled rejection, which is a poor way to learn about a typo.
  writeWebResponse(outgoing, response).catch((error: unknown) => {
    console.error('failed to write response', error);
    outgoing.destroy();
  });
});

const port = Number(process.env.PORT ?? DEFAULT_PORT);

server.listen(port, () => {
  console.log(`lj-api listening on http://localhost:${port}${HEALTH_PATH}`);
});
