/**
 * The local inner loop for `apps/api`, per `../../../CLAUDE.md`
 * (**Local-first development**): it needs no Vercel CLI, no Vercel account and
 * no network beyond the Supabase containers `supabase start` brings up.
 *
 * It mounts the very same exported handlers the deployed functions use, so a
 * behaviour observed here is a behaviour of the real route rather than of a
 * second, drifting implementation of it.
 *
 * Run it through `pnpm --filter @lj/api dev`, which loads
 * `./ts-source-resolution.ts` first. Node cannot follow the `@lj/*` packages'
 * own import specifiers without it -- see the header of that file.
 *
 * Never deployed. Vercel captures a Node server entrypoint only from
 * `server.*` at the project root or in `src/`; a file named `local-server.ts`
 * under `dev/` matches neither, and only files under `api/` become functions.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { POST as DOWNLOAD_URL } from '../src/routes/documents-download-url.ts';
import { POST as UPLOAD_URL } from '../src/routes/documents-upload-url.ts';
import { GET } from '../src/routes/health.ts';
import { POST } from '../src/routes/transition.ts';

const DEFAULT_PORT = 3001;
const HEALTH_PATH = '/api/health';
const TRANSITION_PATH = '/api/transition';
const UPLOAD_URL_PATH = '/api/documents/upload-url';
const DOWNLOAD_URL_PATH = '/api/documents/download-url';

/**
 * The deployed runtime hands the handler a web `Request`; `node:http` deals in
 * `IncomingMessage`. Translating here keeps that difference out of the routes.
 *
 * Headers are forwarded because `/api/transition` authenticates from
 * `Authorization`, and the body because it carries the transition. Both are
 * passed through untouched: a dev server that normalised anything would be a
 * dev server that hid a bug the deployed function will not hide.
 */
async function toWebRequest(incoming: IncomingMessage): Promise<Request> {
  const host = incoming.headers.host ?? `localhost:${DEFAULT_PORT}`;
  const url = new URL(incoming.url ?? '/', `http://${host}`);
  const method = incoming.method ?? 'GET';

  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    }
  }

  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { method, headers });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return new Request(url, { method, headers, body: Buffer.concat(chunks) });
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

async function route(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (request.method === 'GET' && path === HEALTH_PATH) {
    return GET(request);
  }
  if (request.method === 'POST' && path === TRANSITION_PATH) {
    return await POST(request);
  }
  if (request.method === 'POST' && path === UPLOAD_URL_PATH) {
    return await UPLOAD_URL(request);
  }
  if (request.method === 'POST' && path === DOWNLOAD_URL_PATH) {
    return await DOWNLOAD_URL(request);
  }
  return notFound();
}

const server = createServer((incoming, outgoing) => {
  // A rejection here would otherwise take the whole dev server down as an
  // unhandled rejection, which is a poor way to learn about a typo.
  toWebRequest(incoming)
    .then(route)
    .then((response) => writeWebResponse(outgoing, response))
    .catch((error: unknown) => {
      console.error('failed to write response', error);
      outgoing.destroy();
    });
});

const port = Number(process.env['PORT'] ?? DEFAULT_PORT);

server.listen(port, () => {
  console.log(`lj-api listening on http://localhost:${port}`);
  console.log(`  GET  ${HEALTH_PATH}`);
  console.log(`  POST ${TRANSITION_PATH}`);
  console.log(`  POST ${UPLOAD_URL_PATH}`);
  console.log(`  POST ${DOWNLOAD_URL_PATH}`);
});
