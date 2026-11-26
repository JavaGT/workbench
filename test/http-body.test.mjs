import { readRequestBody, readRawBody, BodyError } from '../build/http-body.mjs';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function mockReq({ body, contentType, method = 'POST' } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
  const headers = {};
  if (contentType) headers['content-type'] = contentType;
  return Object.assign(new Readable({
    read() { this.push(buffer); this.push(null); },
  }), { headers, method });
}

function within(promise, milliseconds = 100) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('body read timed out')), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

// BodyError

test('BodyError carries status', () => {
  const e = new BodyError('too big', 413);
  assert.ok(e instanceof Error);
  assert.ok(e instanceof BodyError);
  assert.equal(e.message, 'too big');
  assert.equal(e.status, 413);
});

// readRequestBody — JSON

test('empty body parses to {}', async () => {
  const req = mockReq({ body: '' });
  const result = await readRequestBody(req);
  assert.deepEqual(result, {});
});

test('JSON object', async () => {
  const req = mockReq({ body: '{"a":1}', contentType: 'application/json' });
  const result = await readRequestBody(req);
  assert.deepEqual(result, { a: 1 });
});

test('JSON array', async () => {
  const req = mockReq({ body: '[1,2]', contentType: 'application/json' });
  const result = await readRequestBody(req);
  assert.deepEqual(result, [1, 2]);
});

test('JSON with no content-type defaults to JSON parse', async () => {
  const req = mockReq({ body: '{"x":"y"}' });
  const result = await readRequestBody(req);
  assert.deepEqual(result, { x: 'y' });
});

test('JSON with charset suffix', async () => {
  const req = mockReq({ body: '{"a":1}', contentType: 'application/json; charset=utf-8' });
  const result = await readRequestBody(req);
  assert.deepEqual(result, { a: 1 });
});

test('malformed JSON throws BodyError 400', async () => {
  const req = mockReq({ body: '{bad', contentType: 'application/json' });
  await assert.rejects(
    () => readRequestBody(req),
    (e) => e instanceof BodyError && e.status === 400,
  );
});

test('whitespace-only body treated as empty JSON', async () => {
  const req = mockReq({ body: '  \t\n ', contentType: 'application/json' });
  const result = await readRequestBody(req);
  assert.deepEqual(result, {});
});

// readRequestBody — urlencoded

test('urlencoded body', async () => {
  const req = mockReq({ body: 'a=1&b=2', contentType: 'application/x-www-form-urlencoded' });
  const result = await readRequestBody(req);
  assert.deepEqual(result, { a: '1', b: '2' });
});

test('urlencoded duplicates become array', async () => {
  const req = mockReq({ body: 'x=1&x=2', contentType: 'application/x-www-form-urlencoded' });
  const result = await readRequestBody(req);
  assert.deepEqual(result, { x: ['1', '2'] });
});

test('urlencoded rejects when jsonOnly', async () => {
  const req = mockReq({ body: 'a=1', contentType: 'application/x-www-form-urlencoded' });
  await assert.rejects(
    () => readRequestBody(req, { jsonOnly: true }),
    (e) => e instanceof BodyError && e.status === 415,
  );
});

// readRequestBody — multipart

test('multipart basic field', async () => {
  const boundary = 'boundary123';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="field1"',
    '',
    'value1',
    `--${boundary}--`,
  ].join('\r\n');
  const req = mockReq({ body, contentType: `multipart/form-data; boundary=${boundary}` });
  const result = await readRequestBody(req);
  assert.deepEqual(result, { field1: 'value1' });
});

test('multipart multiple fields', async () => {
  const boundary = 'boundary123';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="a"',
    '',
    'alpha',
    `--${boundary}`,
    'Content-Disposition: form-data; name="b"',
    '',
    'beta',
    `--${boundary}--`,
  ].join('\r\n');
  const req = mockReq({ body, contentType: `multipart/form-data; boundary=${boundary}` });
  const result = await readRequestBody(req);
  assert.deepEqual(result, { a: 'alpha', b: 'beta' });
});

test('multipart duplicate field names become array', async () => {
  const boundary = 'boundary123';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="x"',
    '',
    'first',
    `--${boundary}`,
    'Content-Disposition: form-data; name="x"',
    '',
    'second',
    `--${boundary}--`,
  ].join('\r\n');
  const req = mockReq({ body, contentType: `multipart/form-data; boundary=${boundary}` });
  const result = await readRequestBody(req);
  assert.ok(Array.isArray(result.x));
  assert.deepEqual(result.x, ['first', 'second']);
});

test('multipart file upload', async () => {
  const boundary = 'boundary123';
  const fileContent = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`, 'utf8'),
    Buffer.from('Content-Disposition: form-data; name="file"; filename="test.bin"\r\n', 'utf8'),
    Buffer.from('Content-Type: application/octet-stream\r\n', 'utf8'),
    Buffer.from('\r\n', 'utf8'),
    fileContent,
    Buffer.from(`\r\n--${boundary}--`, 'utf8'),
  ]);
  const req = mockReq({ body, contentType: `multipart/form-data; boundary=${boundary}` });
  const result = await readRequestBody(req);
  assert.ok(result.file);
  assert.equal(result.file.filename, 'test.bin');
  assert.equal(result.file.type, 'application/octet-stream');
  assert.equal(result.file.size, 4);
  assert.deepEqual(result.file.content, fileContent);
});

test('multipart preserves binary high bytes and CRLF alongside UTF-8 text fields', async () => {
  const boundary = 'boundary-bin-utf8';
  const binary = Buffer.from([0x00, 0x0d, 0x0a, 0x80, 0xc3, 0xff, 0x7f]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`, 'utf8'),
    Buffer.from('Content-Disposition: form-data; name="label"\r\n\r\n', 'utf8'),
    Buffer.from('café ☕', 'utf8'),
    Buffer.from(`\r\n--${boundary}\r\n`, 'utf8'),
    Buffer.from('Content-Disposition: form-data; name="blob"; filename="raw.bin"\r\n', 'utf8'),
    Buffer.from('Content-Type: application/octet-stream\r\n\r\n', 'utf8'),
    binary,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  const req = mockReq({ body, contentType: `multipart/form-data; boundary=${boundary}` });
  const result = await readRequestBody(req);
  assert.equal(result.label, 'café ☕');
  assert.equal(result.blob.filename, 'raw.bin');
  assert.equal(result.blob.size, binary.length);
  assert.ok(Buffer.isBuffer(result.blob.content));
  assert.deepEqual(result.blob.content, binary);
});

test('multipart rejects when jsonOnly', async () => {
  const boundary = 'boundary123';
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\nval\r\n--${boundary}--`;
  const req = mockReq({ body, contentType: `multipart/form-data; boundary=${boundary}` });
  await assert.rejects(
    () => readRequestBody(req, { jsonOnly: true }),
    (e) => e instanceof BodyError && e.status === 415,
  );
});

test('multipart missing boundary throws 400', async () => {
  const req = mockReq({ body: 'anything', contentType: 'multipart/form-data' });
  await assert.rejects(
    () => readRequestBody(req),
    (e) => e instanceof BodyError && e.status === 400,
  );
});

// readRequestBody — unsupported content type

test('unsupported content type throws 415', async () => {
  const req = mockReq({ body: 'x', contentType: 'text/xml' });
  await assert.rejects(
    () => readRequestBody(req),
    (e) => e instanceof BodyError && e.status === 415,
  );
});

// readRawBody

test('readRawBody returns buffer for binary upload', async () => {
  const data = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
  const req = mockReq({ body: data, contentType: 'application/octet-stream' });
  const result = await readRawBody(req, 1024);
  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual(result, data);
});

// oversized body

test('readRawBody rejects oversized upload with 413', async () => {
  const data = Buffer.alloc(2000, 'x');
  let pushed = false;
  const req = Object.assign(new Readable({
    read(_size) { if (!pushed) { pushed = true; this.push(data); this.push(null); } },
  }), { headers: {}, method: 'POST' });
  await assert.rejects(
    () => readRawBody(req, 500),
    (e) => e instanceof BodyError && e.status === 413,
  );
});

test('a request body has one reader and a duplicate read fails immediately', async () => {
  const req = Object.assign(new Readable({ read() {} }), { headers: {}, method: 'POST' });
  const first = readRawBody(req, 1024);

  await assert.rejects(
    within(readRequestBody(req)),
    (error) => error instanceof BodyError
      && error.status === 400
      && /already been read/i.test(error.message),
  );

  req.emit('aborted');
  await assert.rejects(within(first), /aborted/i);
});

test('an aborted request rejects instead of leaving its body promise pending', async () => {
  const req = Object.assign(new Readable({ read() {} }), { headers: {}, method: 'POST' });
  const body = readRequestBody(req);

  req.emit('aborted');

  await assert.rejects(
    within(body),
    (error) => error instanceof BodyError
      && error.status === 400
      && /aborted/i.test(error.message),
  );
});

test('a request that closes before end rejects instead of hanging', async () => {
  const req = Object.assign(new Readable({ read() {} }), { headers: {}, method: 'POST' });
  const body = readRequestBody(req);

  req.emit('close');

  await assert.rejects(
    within(body),
    (error) => error instanceof BodyError
      && error.status === 400
      && /closed before completion/i.test(error.message),
  );
});

test('body reader removes all of its listeners after successful completion', async () => {
  const req = mockReq({ body: '{"ok":true}', contentType: 'application/json' });

  assert.deepEqual(await readRequestBody(req), { ok: true });

  for (const event of ['data', 'end', 'error', 'aborted', 'close']) {
    assert.equal(req.listenerCount(event), 0, `${event} listener was removed`);
  }
});

test('content-length over the cap is rejected before body buffering starts', async () => {
  const req = Object.assign(new Readable({ read() {} }), {
    headers: { 'content-length': '2048' },
    method: 'POST',
  });

  await assert.rejects(
    within(readRawBody(req, 1024)),
    (error) => error instanceof BodyError && error.status === 413,
  );
  assert.equal(req.listenerCount('data'), 0);
});
