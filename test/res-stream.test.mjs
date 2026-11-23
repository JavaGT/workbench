// res.stream — the SSE/streaming response helper (#4 + #7 from the Scope
// ergonomics review). A handler streams a Web Response or ReadableStream through
// res.stream; the framework owns the header write + the reader pump + the
// X-Accel-Buffering: no default (the nginx SSE footgun). No res.raw casts, no
// hand-rolled `while (reader.read())` loops in app code.

import { allowAnonymous } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench, { router } from '../build/internal.mjs';

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => {
    if (server.httpServer.listening) resolve();
    else server.httpServer.once('listening', resolve);
  });
  const { port } = server.httpServer.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.httpServer.close(r)),
  };
}

test('res.stream pumps a bare ReadableStream as text/event-stream with X-Accel-Buffering: no', async () => {
  const r = router();
  r.get('/events', allowAnonymous(), (req, res) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: one\n\n'));
        controller.enqueue(new TextEncoder().encode('data: two\n\n'));
        controller.close();
      },
    });
    return res.stream(stream);
  });
  const app = workbench().mount('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/events`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    const text = await res.text();
    assert.equal(text, 'data: one\n\ndata: two\n\n');
  } finally {
    await close();
  }
});

test('res.stream copies a Web Response headers + status and pumps its body', async () => {
  const r = router();
  r.get('/backup', allowAnonymous(), (req, res) => {
    const web = new Response('hello-bytes', {
      status: 202,
      headers: { 'content-type': 'application/octet-stream' },
    });
    return res.stream(web);
  });
  const app = workbench().mount('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/backup`);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(await res.text(), 'hello-bytes');
  } finally {
    await close();
  }
});

test('res.status(n).stream(...) carries the pending status code', async () => {
  const r = router();
  r.get('/partial', allowAnonymous(), (req, res) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'));
        controller.close();
      },
    });
    return res.status(206).stream(stream);
  });
  const app = workbench().mount('/api', r);
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/api/partial`);
    assert.equal(res.status, 206);
    assert.equal(await res.text(), 'chunk');
  } finally {
    await close();
  }
});

test('res.stream sets X-Accel-Buffering: no with { buffering: false } and omits it with { buffering: true }', async () => {
  const r = router();
  r.get('/unbuffered', allowAnonymous(), (req, res) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('unbuffered'));
        controller.close();
      },
    });
    return res.stream(stream, { buffering: false });
  });
  r.get('/buffered', allowAnonymous(), (req, res) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('buffered'));
        controller.close();
      },
    });
    return res.stream(stream, { buffering: true });
  });
  const app = workbench().mount('/api', r);
  const { origin, close } = await listen(app);
  try {
    const unbuffered = await fetch(`${origin}/api/unbuffered`);
    assert.equal(unbuffered.headers.get('x-accel-buffering'), 'no');
    assert.equal(await unbuffered.text(), 'unbuffered');

    const buffered = await fetch(`${origin}/api/buffered`);
    assert.equal(buffered.headers.get('x-accel-buffering'), null);
    assert.equal(await buffered.text(), 'buffered');
  } finally {
    await close();
  }
});

test('mounted handlers can stream with buffering disabled without writing headers twice', async () => {
  const app = workbench().use('/raw', (req, res) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('mounted-ok'));
        controller.close();
      },
    });
    return res.stream(new Response(stream, { headers: { 'content-type': 'application/octet-stream' } }), { buffering: false });
  });
  const { origin, close } = await listen(app);
  try {
    const res = await fetch(`${origin}/raw`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.equal(await res.text(), 'mounted-ok');
  } finally {
    await close();
  }
});

test('res.stream tears down the socket on a mid-stream pump error (no JSON junk appended)', async () => {
  let reads = 0;
  const r = router();
  r.get('/broken', allowAnonymous(), (req, res) => {
    const stream = new ReadableStream({
      pull(controller) {
        reads += 1;
        if (reads === 1) {
          controller.enqueue(new TextEncoder().encode('data: partial\n\n'));
          return;
        }
        // Second pull errors mid-stream, AFTER the first chunk has flushed.
        controller.error(new Error('upstream blew up'));
      },
    });
    return res.stream(stream);
  });
  const app = workbench().mount('/api', r);
  const { origin, close } = await listen(app);
  try {
    // The stream errors mid-flight. Either the socket is torn down (fetch
    // rejects — the correct clean recovery) OR a partial body arrives; in
    // NEITHER case may the body end with a JSON error tail (the body-
    // corruption bug renderError would introduce after headers are sent).
    let text = '';
    try {
      const res = await fetch(`${origin}/api/broken`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      text = await res.text().catch(() => '');
    } catch {
      // Socket torn down before fetch could complete — acceptable.
    }
    assert.ok(
      !text.includes('"error"') && !text.includes('internal error'),
      `stream body should not contain a JSON error tail, got: ${JSON.stringify(text)}`,
    );
  } finally {
    await close();
  }
});
