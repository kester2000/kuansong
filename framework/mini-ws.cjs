'use strict';
/**
 * A very small RFC 6455 server: just enough for a local OneBot mock and for the
 * end-to-end test. No extensions, no fragmentation, text frames only.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const maskKey = masked ? buffer.subarray(cursor, cursor + 4) : null;
    if (masked) cursor += 4;
    if (cursor + length > buffer.length) break;
    let payload = buffer.subarray(cursor, cursor + length);
    if (masked) {
      const copy = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i++) copy[i] = payload[i] ^ maskKey[i % 4];
      payload = copy;
    }
    frames.push({ fin, opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

class MiniWsServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.server = http.createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200).end('ok'); return; }
      res.writeHead(426).end('websocket only');
    });
    this.server.on('upgrade', (req, socket) => this._upgrade(req, socket));
    this.clients = new Set();
    this.options = options;
  }

  listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        const address = this.server.address();
        this.url = `ws://${host}:${address.port}/`;
        resolve(this.url);
      });
    });
  }

  _upgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const client = { socket, buffer: Buffer.alloc(0), headers: req.headers };
    this.clients.add(client);
    this.emit('connection', client);
    socket.on('data', (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      const { frames, rest } = decodeFrames(client.buffer);
      client.buffer = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x8) { socket.end(); this.clients.delete(client); this.emit('disconnect', client); return; }
        if (frame.opcode === 0x9) { socket.write(encodeFrame('', 0xA)); continue; }
        if (frame.opcode === 0x1) this.emit('message', frame.payload.toString('utf8'), client);
      }
    });
    socket.on('close', () => { this.clients.delete(client); this.emit('disconnect', client); });
    socket.on('error', () => { this.clients.delete(client); });
  }

  send(client, text) {
    if (!client || client.socket.destroyed) return false;
    client.socket.write(encodeFrame(text));
    return true;
  }

  broadcast(text) {
    let count = 0;
    for (const client of this.clients) if (this.send(client, text)) count++;
    return count;
  }

  async close() {
    for (const client of this.clients) { try { client.socket.end(); } catch { /* ignore */ } }
    this.clients.clear();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

module.exports = { MiniWsServer, encodeFrame, decodeFrames };
