'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { MiniWsServer, encodeFrame, decodeFrames } = require('../framework/mini-ws.cjs');

test('frame codec round-trips text of every length class', () => {
  for (const text of ['', 'hi', 'x'.repeat(200), 'y'.repeat(70000)]) {
    const { frames, rest } = decodeFrames(encodeFrame(text));
    assert.strictEqual(rest.length, 0);
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].opcode, 0x1);
    assert.strictEqual(frames[0].payload.toString('utf8'), text);
  }
});

test('mini server accepts a real WebSocket client and echoes', async () => {
  const server = new MiniWsServer();
  const url = await server.listen(0);
  const received = [];
  server.on('message', (raw, client) => {
    received.push(raw);
    server.send(client, JSON.stringify({ got: raw }));
  });
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const reply = new Promise((resolve) => ws.addEventListener('message', (event) => resolve(event.data)));
  ws.send('hello');
  assert.strictEqual(await reply, JSON.stringify({ got: 'hello' }));
  assert.deepStrictEqual(received, ['hello']);
  ws.close();
  await server.close();
});

test('mini server handles action envelopes with echo', async () => {
  const server = new MiniWsServer();
  const url = await server.listen(0);
  server.on('message', (raw, client) => {
    const payload = JSON.parse(raw);
    server.send(client, JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 }, echo: payload.echo }));
  });
  const ws = new WebSocket(url);
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  const response = new Promise((resolve) => ws.addEventListener('message', (event) => resolve(JSON.parse(event.data))));
  ws.send(JSON.stringify({ action: 'send_group_msg', params: { group_id: 1, message: 'x' }, echo: 'e1' }));
  const payload = await response;
  assert.strictEqual(payload.echo, 'e1');
  assert.strictEqual(payload.data.message_id, 42);
  ws.close();
  await server.close();
});
