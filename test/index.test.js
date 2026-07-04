import http from 'http';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  IncomingMessage,
  OutgoingMessage
} from '../build/index.js';

function createMockRequest(options = {}) {
  const { method = 'GET', url = '/', headers = {}, body = null } = options;
  const req = new Readable({
    read() {
      if (body) {
        this.push(Buffer.from(body));
      }
      this.push(null);
    }
  });
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req;
}

describe('OutgoingMessage', () => {
  test('returns 204 for empty input', () => {
    const message = OutgoingMessage.from(undefined);
    expect(message.status).toBe(204);
  });

  test('returns 204 for null input', () => {
    const message = OutgoingMessage.from(null);
    expect(message.status).toBe(204);
  });

  test('string content: correct content-length for ASCII', () => {
    const message = OutgoingMessage.from('hello');
    expect(message.status).toBe(200);
    expect(message.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(message.headers['content-length']).toBe('5');
  });

  test('string content: correct content-length for multi-byte UTF-8', () => {
    const message = OutgoingMessage.from('你好');
    // "你好" is 2 chars but 6 bytes in UTF-8
    expect(message.headers['content-length']).toBe('6');
    expect(message.headers['content-length']).not.toBe('2');
  });

  test('string content: correct content-length for emoji', () => {
    const message = OutgoingMessage.from('😀');
    // 😀 is 4 bytes in UTF-8
    expect(message.headers['content-length']).toBe('4');
  });

  test('Buffer content: sets content-length', () => {
    const buf = Buffer.from([1, 2, 3, 4, 5]);
    const message = OutgoingMessage.from(buf);
    expect(message.status).toBe(200);
    expect(message.headers['content-type']).toBe('application/octet-stream');
    expect(message.headers['content-length']).toBe('5');
  });

  test('Readable stream content: no content-length', () => {
    const stream = new Readable({ read() { this.push(null); } });
    const message = OutgoingMessage.from(stream);
    expect(message.status).toBe(200);
    expect(message.headers['content-type']).toBe('application/octet-stream');
    expect(message.headers['content-length']).toBeUndefined();
  });

  test('partial object: uses provided status and headers', () => {
    const message = OutgoingMessage.from({
      status: 201,
      headers: { 'x-custom': 'value' },
      content: 'created'
    });
    expect(message.status).toBe(201);
    expect(message.headers['x-custom']).toBe('value');
  });
});

describe('IncomingMessage', () => {
  test('body is always available regardless of method', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const req = createMockRequest({ method });
      const incoming = new IncomingMessage(req);
      expect(incoming.body).toBeInstanceOf(Promise);
    }
  });

  test('body returns correct content for POST', async () => {
    const req = createMockRequest({ method: 'POST', body: 'hello world' });
    const incoming = new IncomingMessage(req);
    const body = await incoming.body;
    expect(body.toString()).toBe('hello world');
  });

  test('body returns correct content for PATCH', async () => {
    const req = createMockRequest({ method: 'PATCH', body: '{"key":"value"}' });
    const incoming = new IncomingMessage(req);
    const body = await incoming.body;
    expect(body.toString()).toBe('{"key":"value"}');
  });

  test('body returns correct content for GET (empty)', async () => {
    const req = createMockRequest({ method: 'GET' });
    const incoming = new IncomingMessage(req);
    const body = await incoming.body;
    expect(body.length).toBe(0);
  });

  test('body getter is cached (same promise)', () => {
    const req = createMockRequest({ method: 'POST', body: 'data' });
    const incoming = new IncomingMessage(req);
    const p1 = incoming.body;
    const p2 = incoming.body;
    expect(p1).toBe(p2);
  });

  test('reads multi-chunk body correctly', async () => {
    const chunks = ['hello ', 'world'];
    let index = 0;
    const req = new Readable({
      read() {
        if (index < chunks.length) {
          this.push(Buffer.from(chunks[index++]));
        } else {
          this.push(null);
        }
      }
    });
    req.method = 'POST';
    req.url = '/';
    req.headers = {};

    const incoming = new IncomingMessage(req);
    const body = await incoming.body;
    expect(body.toString()).toBe('hello world');
  });

  test('populates url, method, headers', () => {
    const req = createMockRequest({
      method: 'POST',
      url: '/api/users',
      headers: { 'content-type': 'application/json' }
    });
    const incoming = new IncomingMessage(req);
    expect(incoming.url).toBe('/api/users');
    expect(incoming.method).toBe('POST');
    expect(incoming.headers['content-type']).toBe('application/json');
  });

  test('query is lazily parsed as plain object', () => {
    const req = createMockRequest({ url: '/search?q=hello&page=2' });
    const incoming = new IncomingMessage(req);
    expect(incoming.query.q).toBe('hello');
    expect(incoming.query.page).toBe('2');
  });

  test('query handles duplicate keys as array', () => {
    const req = createMockRequest({ url: '/search?tag=a&tag=b&tag=c' });
    const incoming = new IncomingMessage(req);
    expect(incoming.query.tag).toEqual(['a', 'b', 'c']);
  });

  test('query getter is cached (same instance)', () => {
    const req = createMockRequest({ url: '/search?q=hello' });
    const incoming = new IncomingMessage(req);
    const q1 = incoming.query;
    const q2 = incoming.query;
    expect(q1).toBe(q2);
  });

  test('query returns empty object when no query string', () => {
    const req = createMockRequest({ url: '/api/users' });
    const incoming = new IncomingMessage(req);
    expect(incoming.query).toEqual({});
  });
});

describe('applyToResponse', () => {
  let server;
  let port;

  beforeEach(async () => {
    await new Promise((resolve) => {
      server = http.createServer();
      server.listen(0, () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function makeRequest(handler) {
    return new Promise((resolve, reject) => {
      server.once('request', handler);
      const req = http.request(`http://localhost:${port}/`, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString()
          });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  test('sends string response', async () => {
    const outgoing = OutgoingMessage.from('hello');
    const result = await makeRequest(async (req, res) => {
      await outgoing.applyToResponse(res);
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('hello');
    expect(result.headers['content-length']).toBe('5');
  });

  test('sends multi-byte string with correct content-length', async () => {
    const outgoing = OutgoingMessage.from('你好世界');
    const result = await makeRequest(async (req, res) => {
      await outgoing.applyToResponse(res);
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('你好世界');
    expect(result.headers['content-length']).toBe('12'); // 3 chars × 3 bytes each in UTF-8
  });

  test('sends Buffer response', async () => {
    const buf = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    const outgoing = OutgoingMessage.from(buf);
    const result = await makeRequest(async (req, res) => {
      await outgoing.applyToResponse(res);
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('Hello');
    expect(result.headers['content-length']).toBe('5');
  });

  test('sends stream response via pipeline', async () => {
    const stream = Readable.from([Buffer.from('chunk1'), Buffer.from('chunk2')]);
    const outgoing = OutgoingMessage.from(stream);
    const result = await makeRequest(async (req, res) => {
      await outgoing.applyToResponse(res);
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('chunk1chunk2');
  });

  test('pipeline rejects when source stream errors', async () => {
    async function* failingSource() {
      yield Buffer.from('partial');
      throw new Error('source stream error');
    }
    const stream = Readable.from(failingSource());
    const outgoing = OutgoingMessage.from(stream);

    // use a mock response that tracks error/finish events
    const { PassThrough } = await import('stream');
    const mockRes = new PassThrough();
    mockRes.writeHead = () => {};

    await expect(
      outgoing.applyToResponse(mockRes)
    ).rejects.toThrow('source stream error');
  });

  test('sends 204 for empty response', async () => {
    const outgoing = OutgoingMessage.from(undefined);
    const result = await makeRequest(async (req, res) => {
      await outgoing.applyToResponse(res);
    });
    expect(result.status).toBe(204);
  });
});
