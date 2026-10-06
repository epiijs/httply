import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  IncomingMessage,
  OutgoingMessage
} from '../build/index.js';

/**
 * httply 门禁：只断言对外承诺的行为（`README.md` 与 `docs/design-v1.md`）。
 *
 * Node 自身的事件时机、状态位与 server 计时语义不在这里取证，一律由 `spec/` 行为套件按
 * `docs/design-node-test.md` 的 X 条目常驻验证。下面各组的注释标出该承诺依赖的 X 条目：
 * Node 事实变了先看 spec 红，再回来判承诺要不要改。
 */

const BIG = 'x'.repeat(5 * 1024 * 1024);
let portSeed = 39320;

function nextPort() {
  portSeed += 1;
  return portSeed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slowStream(total = 400, chunkSize = 1024, delay = 1) {
  let sent = 0;
  return Readable.from((async function* () {
    while (sent < total) {
      sent += 1;
      yield Buffer.alloc(chunkSize, 0x78);
      if (delay) await sleep(delay);
    }
  })());
}

// 不经过 http 模块的 socket 客户端，abortAfter 支持 'first-byte' | 毫秒数 | 'never'
function connectAndAbort(port, abortAfter) {
  return new Promise((resolve) => {
    const socket = net.connect(port);
    const state = { receivedBytes: 0 };
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      state.receivedBytes += chunk.length;
      if (abortAfter === 'first-byte') socket.destroy();
    });
    socket.on('connect', async () => {
      socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
      if (typeof abortAfter === 'number') {
        await sleep(abortAfter);
        socket.destroy();
      }
      resolve({ socket, state });
    });
  });
}

/**
 * 出站探针：调用 applyToResponse，记录事件顺序与 settle 结果。
 * 收敛窗只在「已知终止事件全部到达」之后起算：`close` 可能早于本次写入（handler 等待 body 或 IO 期间
 * 客户端已断连，spec X3-5，且 close 不再触发第二次），也可能晚于写入完成（流在传输中途断开）。settle
 * 后只留极短窗口等待 close 记录，避免在新事件到达前误判为未 settle
 */
function probeApply({ content, writeDelay = 0, abortAfter, resDestroyAt = null }) {
  const port = nextPort();
  const graceMs = 150;
  const capMs = 1000;
  return new Promise((resolve) => {
    const events = [];
    const states = {};
    const timers = [];
    let settled = null;
    let completed = null;
    let settleDetail = null;
    let client = null;
    let done = false;
    let closed = false;
    let called = false;
    let graceTimer = null;
    const t0 = Date.now();
    const record = (name) => events.push(`${name}@${Date.now() - t0}`);

    const finish = (res) => {
      if (done) {
        return;
      }
      done = true;
      timers.forEach((timer) => clearTimeout(timer));
      clearTimeout(graceTimer);
      states.receivedBytes = client ? client.state.receivedBytes : null;
      server.close();
      server.closeAllConnections();
      resolve({ events, settled, completed, settleDetail, states });
    };
    const armGrace = (res, ms) => {
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => finish(res), ms);
    };
    const schedule = (res) => {
      if (done) {
        return;
      }
      if (settled) {
        armGrace(res, 30);
      } else if (closed && called) {
        armGrace(res, graceMs);
      }
    };

    const server = http.createServer(async (req, res) => {
      timers.push(setTimeout(() => finish(res), capMs));
      if (resDestroyAt !== null) {
        timers.push(setTimeout(() => {
          record('server.res.destroy');
          res.destroy();
        }, resDestroyAt));
      }
      res.on('finish', () => record('res.finish'));
      res.on('close', () => {
        record('res.close');
        closed = true;
        schedule(res);
      });
      res.on('error', (error) => record(`res.error(${error.code || error.message})`));
      req.on('aborted', () => record('req.aborted'));

      if (writeDelay) {
        await sleep(writeDelay);
      }

      OutgoingMessage.from(content).applyToResponse(res).then(
        (result) => {
          settled = 'resolve';
          completed = result.completed;
          record(`promise.resolve(completed=${result.completed})`);
          schedule(res);
        },
        (error) => {
          settled = 'reject';
          settleDetail = error.code || error.message;
          record(`promise.reject(${settleDetail})`);
          schedule(res);
        }
      );

      called = true;
      schedule(res);
    });

    server.listen(port, async () => {
      client = await connectAndAbort(port, abortAfter);
    });
  });
}

/**
 * 入站探针：`writes` 的 at 是相对上一次写的延迟毫秒；framing 为 chunked 时按 chunk 帧写出。
 * rawHead 换掉整个请求头（GET / HEAD / `Content-Length: 0` 形态），respondViaHttply 时额外采集
 * 响应 finish 时刻与下一个 tick 的请求流状态，那是回收判据的依据（spec X7-2）
 */
function probeIncoming({
  framing = 'content-length', declared = 0, writes = [], terminateChunked = false, rawHead = null,
  clientDestroyAt = null, serverDestroyAt = null, readBody = true, followUp = false,
  readAfterRespond = false, respondViaHttply = false, capMs = 2500
}) {
  const port = nextPort();
  const graceMs = 150;
  return new Promise((resolve) => {
    const events = [];
    const states = {};
    const timers = [];
    let settled = null;
    let settleCode = null;
    let bodyBytes = null;
    let clientBytes = 0;
    let closed = false;
    let reading = false;
    let done = false;
    let requestCount = 0;
    let graceTimer = null;
    const t0 = Date.now();
    const record = (name) => events.push(`${name}@${Date.now() - t0}`);

    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      timers.forEach((timer) => clearTimeout(timer));
      clearTimeout(graceTimer);
      states.clientBytes = clientBytes;
      states.requestCount = requestCount;
      server.close();
      server.closeAllConnections();
      resolve({ events, settled, settleCode, bodyBytes, states });
    };
    const arm = (ms) => {
      clearTimeout(graceTimer);
      graceTimer = setTimeout(finish, ms);
    };
    // 与出站探针同一套收敛规则：settle 即收敛，未 settle 时，等到 close 与读取结果都已知才开始计时
    const schedule = () => {
      if (done) {
        return;
      }
      if (settled) {
        arm(40);
      } else if (closed && reading) {
        arm(graceMs);
      }
    };

    const server = http.createServer(async (req, res) => {
      requestCount += 1;
      record(`request#${requestCount}`);
      // httply 的首次访问必须早于探针自己的 data 监听：data 监听会把流置为 flowing，
      // 那些标志位正是 readRawBody 判断请求流是否已被取走所读的对象，先挂监听就改变了被测状态
      const startRead = () => {
        reading = true;
        // 首次访问时刻的流状态是判据的直接对象，必须在读取之前取
        states.atRead = {
          didRead: req.readableDidRead, flowing: req.readableFlowing, ended: req.readableEnded
        };
        const incoming = new IncomingMessage(req);
        schedule();
        incoming.body.then(
          (buf) => {
            settled = 'resolve';
            bodyBytes = buf.length;
            record(`body.resolve(${buf.length})`);
            schedule();
          },
          (error) => {
            settled = 'reject';
            settleCode = error.code ?? null;
            // 事件名只用于失败时读数，诊断信息取 code，缺 code 才回落 message
            record(`body.reject(${settleCode || error.message})`);
            schedule();
          }
        );
      };
      if (readBody && !readAfterRespond) {
        startRead();
      }
      // readAfterRespond 时探针不挂 data 监听，否则 flowing 是探针造成的，
      // 观测到的「已取走」就不能归到 Node 响应 finish 的丢弃上
      if (!readAfterRespond) {
        req.on('data', () => record('req.data'));
      }
      req.on('end', () => record('req.end'));
      req.on('aborted', () => record('req.aborted'));
      req.on('error', (error) => record(`req.error(${error.code || error.message})`));
      req.on('close', () => {
        record('req.close');
        closed = true;
        schedule();
      });
      res.on('finish', () => {
        record('res.finish');
        if (respondViaHttply) {
          states.atFinish = { ended: req.readableEnded, complete: req.complete };
          setImmediate(() => {
            states.atNextTick = { ended: req.readableEnded, complete: req.complete };
          });
        }
        // 响应 finish 后 Node 已丢弃残余请求体，此时才首次访问 body
        if (readBody && readAfterRespond) {
          startRead();
        }
      });
      // socket 级对照：区分「Node 不派发入站事件」与「连接关闭尚未被感知」
      req.socket.on('close', (hadError) => record(`socket.close(hadError=${hadError})`));
      req.socket.on('error', (error) => record(`socket.error(${error.code || error.message})`));
      req.socket.on('end', () => record('socket.end'));

      timers.push(setTimeout(finish, capMs));
      if (serverDestroyAt !== null) {
        timers.push(setTimeout(() => {
          record('server.req.destroy');
          req.destroy();
        }, serverDestroyAt));
      }

      if (respondViaHttply) {
        OutgoingMessage.from('ok').applyToResponse(res);
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }
    });

    server.listen(port, () => {
      const socket = net.connect(port);
      socket.on('error', () => {});
      socket.resume();
      socket.on('data', (chunk) => {
        clientBytes += chunk.length;
      });
      socket.on('connect', async () => {
        const head = rawHead ?? (framing === 'chunked'
          ? 'POST / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n'
          : `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${declared}\r\nConnection: keep-alive\r\n\r\n`);
        socket.write(head);
        for (const part of writes) {
          if (part.at) {
            await sleep(part.at);
          }
          const payload = framing === 'chunked'
            ? `${part.size ?? part.bytes.toString(16)}\r\n${'x'.repeat(part.bytes)}\r\n`
            : 'x'.repeat(part.bytes);
          socket.write(payload);
          record(`client.write(${part.bytes})`);
        }
        if (framing === 'chunked' && terminateChunked) {
          socket.write('0\r\n\r\n');
          record('client.terminate');
        }
        if (clientDestroyAt !== null) {
          await sleep(clientDestroyAt);
          socket.destroy();
          record('client.destroy');
        }
        if (followUp) {
          await sleep(60);
          socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
          record('client.followup');
        }
      });
    });
  });
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
  // 真实 http 回环：服务端构造 IncomingMessage，观测结果以 base64 编码进响应头回传。
  // 走响应头而非响应体，HEAD 这类响应不带 body 的方法才能与其余方法用同一套断言
  function inspectRequest({ method = 'POST', path = '/', body = null, chunks = null, headers = {} }, collect) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const incoming = new IncomingMessage(req);
        let payload;
        try {
          payload = { ok: true, facts: await collect(incoming) };
        } catch (error) {
          payload = { ok: false, error: error.message };
        }
        res.writeHead(200, { 'x-httply-inspect': Buffer.from(JSON.stringify(payload)).toString('base64') });
        res.end();
      });
      server.listen(0, () => {
        const req = http.request(
          // agent:false 关掉全局 keep-alive 连接池：连续用例可能复用上一个已关闭服务的残留连接
          { port: server.address().port, method, path, headers, agent: false },
          (res) => {
            res.on('end', () => {
              server.close();
              const encoded = res.headers['x-httply-inspect'];
              if (typeof encoded !== 'string') {
                reject(new Error(`missing x-httply-inspect (status ${res.statusCode})`));
                return;
              }
              resolve(JSON.parse(Buffer.from(encoded, 'base64').toString()));
            });
            res.resume();
          }
        );
        req.on('error', (error) => {
          server.close();
          reject(error);
        });
        if (chunks) {
          chunks.forEach((chunk) => req.write(chunk));
        } else if (body !== null) {
          req.write(body);
        }
        req.end();
      });
    });
  }

  test('body is always available regardless of method', async () => {
    // 只有 POST/PUT/PATCH 构造真实 body：限制来自 Node 的客户端而非服务端——`http.request`
    // 只为这三个方法写出 body，其余方法的 body 字节被客户端丢弃，服务端把残字节当新请求解析，
    // 随即报 HPE_INVALID_METHOD（keep-alive）或 HPE_CLOSED_CONNECTION（close）。
    // 服务端本身不按 method 拦截请求体，该项取证见 spec X1-3
    const bodyMethods = ['POST', 'PUT', 'PATCH'];
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const result = await inspectRequest(
        { method, body: bodyMethods.includes(method) ? 'x' : null },
        async (incoming) => {
          const getter = incoming.body;
          await getter;
          return getter instanceof Promise;
        }
      );
      expect(result, method).toEqual({ ok: true, facts: true });
    }
  });

  test('body returns correct content for POST', async () => {
    const result = await inspectRequest(
      { method: 'POST', body: 'hello world' },
      async (incoming) => (await incoming.body).toString()
    );
    expect(result.facts).toBe('hello world');
  });

  test('body returns correct content for PATCH', async () => {
    const result = await inspectRequest(
      { method: 'PATCH', body: '{"key":"value"}' },
      async (incoming) => (await incoming.body).toString()
    );
    expect(result.facts).toBe('{"key":"value"}');
  });

  test('body returns empty buffer for GET', async () => {
    const result = await inspectRequest(
      { method: 'GET' },
      async (incoming) => (await incoming.body).length
    );
    expect(result.facts).toBe(0);
  });

  test('body getter is cached (same promise)', async () => {
    const result = await inspectRequest(
      { method: 'POST', body: 'data' },
      async (incoming) => {
        const p1 = incoming.body;
        const p2 = incoming.body;
        await p1;
        return p1 === p2;
      }
    );
    expect(result.facts).toBe(true);
  });

  test('reads multi-chunk body correctly', async () => {
    const result = await inspectRequest(
      { method: 'POST', chunks: ['hello ', 'world'] },
      async (incoming) => (await incoming.body).toString()
    );
    expect(result.facts).toBe('hello world');
  });

  test('populates url, method, headers', async () => {
    const result = await inspectRequest(
      {
        method: 'POST',
        path: '/api/users',
        body: 'x',
        headers: { 'content-type': 'application/json' }
      },
      (incoming) => ({
        url: incoming.url,
        method: incoming.method,
        contentType: incoming.headers['content-type']
      })
    );
    expect(result.facts).toEqual({
      url: '/api/users',
      method: 'POST',
      contentType: 'application/json'
    });
  });

  test('query is lazily parsed as plain object', async () => {
    const result = await inspectRequest(
      { method: 'GET', path: '/search?q=hello&page=2' },
      (incoming) => incoming.query
    );
    expect(result.facts).toEqual({ q: 'hello', page: '2' });
  });

  test('query handles duplicate keys as array', async () => {
    const result = await inspectRequest(
      { method: 'GET', path: '/search?tag=a&tag=b&tag=c' },
      (incoming) => incoming.query
    );
    expect(result.facts).toEqual({ tag: ['a', 'b', 'c'] });
  });

  test('query getter is cached (same instance)', async () => {
    const result = await inspectRequest(
      { method: 'GET', path: '/search?q=hello' },
      (incoming) => incoming.query === incoming.query
    );
    expect(result.facts).toBe(true);
  });

  test('query returns empty object when no query string', async () => {
    const result = await inspectRequest(
      { method: 'GET', path: '/api/users' },
      (incoming) => incoming.query
    );
    expect(result.facts).toEqual({});
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

  test('resolves with completed true once the response is flushed', async () => {
    const outgoing = OutgoingMessage.from('hello');
    const result = await makeRequest(async (req, res) => {
      const sent = await outgoing.applyToResponse(res);
      expect(sent.completed).toBe(true);
    });
    expect(result.body).toBe('hello');
  });

  test('sends 204 for empty response', async () => {
    const outgoing = OutgoingMessage.from(undefined);
    const result = await makeRequest(async (req, res) => {
      await outgoing.applyToResponse(res);
    });
    expect(result.status).toBe(204);
  });
});

describe('applyToResponse settles when the connection ends', () => {
  // 依据：断连路径 `res` 只派发 close（spec X2-4），`finish` 与状态位都判不出完整性
  // （spec X4-1/X4-2/X4-3），所以 settle 取 finish 与 close 的先到者，
  // completed 严格等于「finish 是否发生」，断连不是错误

  test('completed stays true once the body reached the kernel, even if the client read only part', async () => {
    const observed = await probeApply({ content: BIG, abortAfter: 'first-byte' });
    expect(observed.settled).toBe('resolve');
    expect(observed.completed).toBe(true);
    expect(observed.states.receivedBytes).toBeLessThan(BIG.length);
  }, 20000);

  test('a write after the client already left settles with completed false', async () => {
    // close 已在写入前派发过一次，只补监听会一直等待 → 入口处的连接状态判定（spec X3-1/X3-5）
    const observed = await probeApply({ content: BIG, writeDelay: 200, abortAfter: 60 });
    expect(observed.settled).toBe('resolve');
    expect(observed.completed).toBe(false);
    expect(observed.events.join()).not.toContain('res.finish');
  }, 20000);

  test('a 204 written after the client already left settles rather than hanging', async () => {
    const observed = await probeApply({ content: undefined, writeDelay: 200, abortAfter: 60 });
    expect(observed.settled).toBe('resolve');
    expect(observed.completed).toBe(false);
  }, 20000);

  test('piping onto an already-closed response is a termination, not an error', async () => {
    // 目标在 pipeline 建立前已终止时，一律同步抛 ERR_STREAM_UNABLE_TO_PIPE 且不派发回调（spec X5-1）；
    // 该形态无文档条款且上游正在修订，实现不得收紧成单独依赖 pipeline
    const observed = await probeApply({ content: slowStream(200), writeDelay: 200, abortAfter: 60 });
    expect(observed.settled).toBe('resolve');
    expect(observed.completed).toBe(false);
  }, 20000);

  test('a stream interrupted mid-pipe settles with completed false', async () => {
    // 写入途中断连由回调报 ERR_STREAM_PREMATURE_CLOSE，目标被 pipeline 连带销毁（spec X5-2/X5-3）
    const observed = await probeApply({ content: slowStream(300, 1024, 10), abortAfter: 120 });
    expect(observed.settled).toBe('resolve');
    expect(observed.completed).toBe(false);
  }, 20000);

  test('a response destroyed by the server mid-write settles through the callback attribution', async () => {
    // 该形态下 res 的 close 不一定派发（spec X5-1c），settle 只能来自 pipeline 回调；
    // 而真实响应上目标恒被连带销毁，回调错误一律 PREMATURE_CLOSE，判不出原因（spec X5-3），
    // 归因只依据先捕获的源流错误，此处没有源流错误，按目标侧终止 resolve
    const observed = await probeApply({
      content: slowStream(300, 1024, 10),
      abortAfter: 'never',
      resDestroyAt: 120
    });
    expect(observed.settled).toBe('resolve');
    expect(observed.completed).toBe(false);
    expect(observed.events.join()).not.toContain('res.finish');
  }, 20000);

  test('piping onto an already-closed response releases the content stream', async () => {
    // 入口处的连接状态判定除了 settle，还要销毁未消费的内容流，否则文件句柄一类资源悬置
    const source = slowStream(200);
    const observed = await probeApply({ content: source, writeDelay: 200, abortAfter: 60 });
    expect(observed.settled).toBe('resolve');
    expect(observed.completed).toBe(false);
    expect(source.destroyed).toBe(true);
  }, 20000);

  test('a failing content stream rejects with its own error, even if close arrives first', async () => {
    // 先捕获源流错误，close 监听不覆盖它：close 可早于回调到达（spec X5-4）
    const failing = Readable.from((async function* () {
      yield Buffer.from('partial');
      throw new Error('source boom');
    })());
    const observed = await probeApply({ content: failing, abortAfter: 'never' });
    expect(observed.settled).toBe('reject');
    expect(observed.settleDetail).toBe('source boom');
  }, 20000);

  test('a second call on the same response rejects with ERR_HTTP_HEADERS_SENT', async () => {
    // 重复写入属编程错误，必须报错而不是静默按终止返回（spec X6-1、X2-6）
    const port = nextPort();
    const observed = await new Promise((resolve) => {
      const result = { second: 'pending' };
      const server = http.createServer(async (req, res) => {
        req.resume();
        await OutgoingMessage.from('first').applyToResponse(res);
        try {
          await OutgoingMessage.from('second').applyToResponse(res);
          result.second = 'resolved';
        } catch (error) {
          result.second = `rejected(${error.code || error.message})`;
        }
        server.close();
        server.closeAllConnections();
        resolve(result);
      });
      server.listen(port, () => connectAndAbort(port, 'never'));
      setTimeout(() => {
        server.close();
        server.closeAllConnections();
        resolve(result);
      }, 1500);
    });
    expect(observed.second).toContain('rejected');
    expect(observed.second).toContain('ERR_HTTP_HEADERS_SENT');
  }, 20000);
});

describe('incoming body terminates on truncated requests', () => {
  // 依据：响应一旦发出，Node 不再向 `req` 派发终止事件，截断只剩 socket 层可见
  // （spec X1-1/X2-1），故实现以 `request.socket` 的 close 保证 Promise 一定 settle；chunked 缺终止块时
  // `end` 永不触发（spec X1-2）

  test('a truncated content-length body rejects with request aborted after the response went out', async () => {
    const observed = await probeIncoming({ declared: 1000, writes: [{ at: 0, bytes: 400 }], clientDestroyAt: 40 });
    expect(observed.settled).toBe('reject');
    expect(observed.settleCode).toBe('HTTPLY_BODY_ABORTED');
    expect(observed.events.join()).toContain('socket.close');
    expect(observed.events.join()).not.toContain('req.aborted');
    expect(observed.events.join()).not.toContain('req.error');
    expect(observed.events.join()).not.toContain('req.close');
  }, 20000);

  test('a chunked body without its terminating chunk rejects the same way', async () => {
    const observed = await probeIncoming({ framing: 'chunked', writes: [{ at: 0, bytes: 200 }], clientDestroyAt: 40 });
    expect(observed.settled).toBe('reject');
    expect(observed.settleCode).toBe('HTTPLY_BODY_ABORTED');
    expect(observed.events.join()).toContain('socket.close');
    expect(observed.events.join()).not.toContain('req.close');
  }, 20000);

  test('a server-side req.destroy rejects with request aborted', async () => {
    // 服务端 destroy 只派发 aborted 与 close，不派发 error（spec X2-3）。
    // 实现不监听 aborted：该形态下 socket close 同样到达（spec X3-3），Promise 照样 settle
    const observed = await probeIncoming({ declared: 1000, writes: [{ at: 0, bytes: 400 }], serverDestroyAt: 60 });
    expect(observed.settled).toBe('reject');
    expect(observed.settleCode).toBe('HTTPLY_BODY_ABORTED');
    expect(observed.events.join()).toContain('req.aborted');
    expect(observed.events.join()).not.toContain('req.error');
  }, 20000);

  test('a malformed chunk size rejects with request aborted', async () => {
    // 解析错误走 req 的 error 事件（spec X2-2 的派发面）：error 监听必须存在，否则 Node 把该事件抛到进程外。
    // 对外的失败原因统一为 HTTPLY_BODY_ABORTED，不向调用方暴露 llhttp 的错误码
    const observed = await probeIncoming({ framing: 'chunked', writes: [{ at: 0, bytes: 16, size: 'zz' }] });
    expect(observed.settled).toBe('reject');
    expect(observed.settleCode).toBe('HTTPLY_BODY_ABORTED');
  }, 20000);

  test('headers only, then a disconnect, still terminates the read', async () => {
    const observed = await probeIncoming({ declared: 1000, writes: [], clientDestroyAt: 40 });
    expect(observed.settled).toBe('reject');
    expect(observed.settleCode).toBe('HTTPLY_BODY_ABORTED');
    expect(observed.events.join()).not.toContain('req.data');
  }, 20000);
});

describe('reading the body after responding is an error', () => {
  // 依据：响应 finish 时 Node 把请求流置为 flowing 并丢弃残余数据（spec X2-5）。静默 resolve(0)
  // 会让使用方把「未读到」当成「没有 body」，故在首次访问时刻即判定并 reject 已丢弃

  test('a body fully sent but read after the response rejects immediately', async () => {
    // body 已完整发送，客户端没有任何违约；只是读取时机过晚
    const observed = await probeIncoming({
      declared: 100, writes: [{ at: 0, bytes: 100 }], readAfterRespond: true, capMs: 800
    });
    expect(observed.settled).toBe('reject');
    expect(observed.settleCode).toBe('HTTPLY_BODY_DROPPED');
    // 即时收敛：reject 与 res.finish 同一时刻，不等 socket close
    expect(observed.events.join()).toContain('res.finish');
    expect(observed.events.join()).not.toContain('body.resolve');
  }, 20000);

  test('the same rejection holds under chunked framing', async () => {
    // 判据不能只对 `Content-Length` 定长这一种界定方式成立
    const observed = await probeIncoming({
      framing: 'chunked', writes: [{ at: 0, bytes: 64 }], terminateChunked: true,
      readAfterRespond: true, capMs: 300
    });
    expect(observed.settleCode).toBe('HTTPLY_BODY_DROPPED');
  }, 20000);

  test('a body arriving after the response is caught by flowing alone', async () => {
    // 这条用例决定了首次访问要把两个标志位一起读：此时 readableDidRead 仍为 false，单独判它覆盖不到
    const observed = await probeIncoming({
      declared: 100, writes: [{ at: 0, bytes: 50 }, { at: 15, bytes: 50 }], readAfterRespond: true, capMs: 300
    });
    expect(observed.states.atRead).toEqual({ didRead: false, flowing: true, ended: false });
    expect(observed.settleCode).toBe('HTTPLY_BODY_DROPPED');
    // 首次访问之后残余 body 仍在到达：客户端并未违约，残余数据是在响应 finish 时被 Node 丢弃的
    expect(observed.events.filter((name) => name.startsWith('client.write'))).toHaveLength(2);
  }, 20000);

  test('a truncated body read after the response rejects at once, not later as aborted', async () => {
    // 修复前这条要等 keepAliveTimeout 到期（实测 2.5s），且 code 误报为 HTTPLY_BODY_ABORTED
    const observed = await probeIncoming({
      declared: 1000, writes: [{ at: 0, bytes: 400 }], readAfterRespond: true, capMs: 300
    });
    expect(observed.settleCode).toBe('HTTPLY_BODY_DROPPED');
  }, 20000);
});

describe('the connection is reclaimed after the response', () => {
  // 依据：截断且未消费的 body 会占用连接、后续请求不被处理（spec X7-1）；httply 在 finish 后延后一个 tick
  // 检查并销毁该请求，此时响应已交入内核，客户端仍完整收到，socket 干净关闭而非 RST（spec X7-3）

  test('an unread truncated body is reclaimed without any help from the caller', async () => {
    // keepAliveTimeout 默认 5000ms 而 capMs 只有 900ms：观察时间内等得到 socket.close，
    // 说明该关闭并非超时触发，而是响应 finish 后 httply 主动销毁了请求
    const observed = await probeIncoming({
      declared: 1000, writes: [{ at: 0, bytes: 400 }], readBody: false, respondViaHttply: true, capMs: 900
    });
    expect(observed.events.join()).toContain('res.finish');
    expect(observed.events.join()).toContain('req.aborted');
    expect(observed.events.join()).toContain('socket.close(hadError=false)');
    expect(observed.states.clientBytes).toBeGreaterThan(100);
    expect(observed.states.requestCount).toBe(1);
  }, 20000);

  test('a fully sent body is not reclaimed, so the connection stays in service', async () => {
    const observed = await probeIncoming({
      declared: 100, writes: [{ at: 0, bytes: 100 }],
      readBody: false, respondViaHttply: true, followUp: true, capMs: 900
    });
    expect(observed.events.join()).not.toContain('req.aborted');
    expect(observed.states.requestCount).toBe(2);
  }, 20000);

  test('the reclaim check only works one tick after finish', async () => {
    // body 已完整发送而无人读取：Node 要到响应 finish才把流推进到 flowing 并交付 end。在 finish 时刻判定会误销毁
    // 这条连接，因此实现中的延后一个 tick 是必需的，不是可选的调度细节（spec X7-2）
    const observed = await probeIncoming({
      declared: 100, writes: [{ at: 0, bytes: 100 }], readBody: false, respondViaHttply: true, capMs: 300
    });
    expect(observed.states.atFinish).toEqual({ ended: false, complete: false });
    expect(observed.states.atNextTick).toEqual({ ended: true, complete: true });
  }, 20000);

  test('requests without a body survive the reclaim check', async () => {
    // 回收若误销毁这些形态，keep-alive 会在每一个 GET 上失效；这条用例覆盖该判定的边界（spec X7-4）
    const shapes = [
      ['GET', 'GET /a HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n'],
      ['HEAD', 'HEAD /a HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n'],
      ['Content-Length: 0', 'POST /a HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n']
    ];
    for (const [name, rawHead] of shapes) {
      const observed = await probeIncoming({
        rawHead, readBody: false, respondViaHttply: true, followUp: true, capMs: 400
      });
      expect(observed.events.join(), name).not.toContain('req.aborted');
      expect(observed.states.requestCount, name).toBe(2);
    }
  }, 20000);
});
