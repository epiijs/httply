import http from 'node:http';
import { describe, expect, test } from 'vitest';

import { boundedWait, closeAll, listen, makeTimeline, rawConnect, recordReq, recordRes, recordSocket, slowStream, sleep } from './helpers.js';

/**
 * X8 server 计时的分工（P7）
 * server 实例不挂 timeout 监听，保留默认「到期销毁闲置 socket」行为（方案原则：观测不改变被测方）
 * X9-4（各计时器默认值）与实现无关，用例在 x9-behavior-archive.test.js
 */
describe('X8 server 计时的分工', () => {
  test('X8-1 server.timeout 到期销毁「未响应 + body 停发」的闲置 socket', async () => {
    const t = makeTimeline('X8-1a');
    const server = http.createServer((req, res) => {
      recordReq(req, t);
      recordRes(res, t);
      recordSocket(req.socket, t);
      // 不应答，等 body
    });
    server.timeout = 400;
    const port = await listen(server);
    await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 100\r\n\r\n',
      body: 'x'.repeat(40),
      mode: 'keep'
    });
    await sleep(1200);
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    expect(stream).toContain('sock.timeout');
    expect(stream).toContain('socket.close');
    expect(stream).toContain('req.aborted');
  });

  test('X8-1 入站活动重置闲置计时：每 300ms 发送 1 字节，400ms 计时永不触发', async () => {
    const t = makeTimeline('X8-1b');
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: true });
      recordSocket(req.socket, t);
    });
    server.timeout = 400;
    const port = await listen(server);
    const { socket } = await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 10000\r\n\r\n',
      mode: 'keep'
    });
    for (let i = 0; i < 6; i += 1) {
      await sleep(300);
      socket.write('x');
    }
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    socket.destroy();
    expect(stream).not.toContain('sock.timeout'); // 低速持续发送可无限延长：这是闲置计时而非总时限
  });

  test('X8-1 慢响应对照：持续写入的慢响应不被 server.timeout 打断', async () => {
    const t = makeTimeline('X8-1c');
    const seen = {};
    const wait = boundedWait(4000);
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      res.writeHead(200);
      const source = slowStream(240, 1024, 5);
      source.on('error', () => {});
      source.pipe(res);
      res.on('finish', () => {
        seen.finish = true;
        wait.done();
      });
    });
    server.timeout = 300;
    const port = await listen(server);
    await rawConnect(port, { head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n', mode: 'keep' });
    await wait.promise;
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    expect(seen.finish).toBe(true);
    expect(stream).not.toContain('sock.timeout'); // 写入活动同样重置闲置计时
  });

  test('X8-2 对照组：默认检查间隔下，未响应且 body 停发在秒级观察时间内无计时动作', async () => {
    const t = makeTimeline('X8-2');
    const server = http.createServer((req, res) => {
      recordReq(req, t);
      recordRes(res, t);
      recordSocket(req.socket, t);
    });
    server.requestTimeout = 200;
    server.headersTimeout = 150;
    server.keepAliveTimeout = 100;
    const port = await listen(server);
    await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 100\r\n\r\n',
      body: 'x'.repeat(40),
      mode: 'keep'
    });
    // 有界窗取最小配置值（200）的五倍余量（原则 1）
    await sleep(1200);
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    expect(stream).not.toContain('sock.timeout');
    expect(stream).not.toContain('req.aborted');
    expect(stream).not.toContain('req.error');
    expect(stream).not.toContain('socket.close');
  });

  // 上一条的「不参与」是检查间隔造成的假象：requestTimeout/headersTimeout 由
  // connectionsCheckingInterval（默认 30000ms）的低频扫描器执行，观察时间跨不过一次扫描。
  // 本条将检查间隔设为 100ms，同一形态即在 max(requestTimeout, headersTimeout) 处过期。
  test('X8-2 控制组：调小 connectionsCheckingInterval 后，body 停发的请求按 max(rt, ht) 过期并回 408', async () => {
    const t = makeTimeline('X8-2-ctl');
    const seen = {};
    const server = http.createServer({ requestTimeout: 300, headersTimeout: 300, connectionsCheckingInterval: 100 }, (req, res) => {
      seen.req = req;
      seen.handled = true;
      t.record('handler');
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      // 请求已转发给 handler，故意不应答
    });
    t.record(`cfg(rt=${server.requestTimeout},ht=${server.headersTimeout},cci=${server.connectionsCheckingInterval})`);
    const port = await listen(server);
    const { state } = await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 100\r\n\r\n',
      body: 'x'.repeat(40),
      mode: 'keep',
      readResponse: true
    });
    await sleep(1200);
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    expect(seen.handled).toBe(true); // 已转发给 handler，仍被扫描器判过期
    expect(stream).toContain('socket.error(ERR_HTTP_REQUEST_TIMEOUT)');
    expect(stream).toContain('req.aborted');
    expect(state.response).toContain('408');
    expect(seen.req.complete).toBe(false);
  });

  // 与 server.timeout 的分工判据：入站有推进时两者表现相反。
  // server.timeout 是闲置计时，逐字节重置（见本文件 X8-1 的入站活动条）；requestTimeout 是总时限，低速持续发送不重置它
  test('X8-3 requestTimeout 是总时限：入站低速持续发送不重置它', async () => {
    const t = makeTimeline('X8-3');
    const server = http.createServer({ requestTimeout: 300, headersTimeout: 300, connectionsCheckingInterval: 100 }, (req, res) => {
      recordReq(req, t, { data: true });
      recordSocket(req.socket, t);
    });
    const port = await listen(server);
    const { socket } = await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 10000\r\n\r\n',
      mode: 'keep'
    });
    for (let i = 0; i < 6; i += 1) {
      await sleep(60);
      if (socket.writable) {
        socket.write('x');
        t.record('drip');
      }
    }
    await sleep(600);
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    socket.destroy();
    // 低速持续发送在先，仍按原定过期时刻生效：这是总时限而非闲置计时
    expect(stream).toContain('drip');
    expect(stream).toContain('socket.error(ERR_HTTP_REQUEST_TIMEOUT)');
    expect(stream).not.toContain('sock.timeout'); // 未走 server.timeout 路径
  });

  // 出站停滞形态在 macOS 回环上可本地构造：客户端不挂 data 监听（对端零读取），
  // 服务端按背压写（write 返回 false 即等 drain），约 850KB 后真实挂起。
  // 旧结论「192MB 全被内核缓冲区吸收、写入不挂起」出自不尊重背压的写法，已作废（见报告推翻记录）
  async function writeUntilStalled(stream, { total, patienceMs }) {
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    let sent = 0;
    while (sent < total) {
      const ok = stream.write(chunk);
      sent += chunk.length;
      if (ok) {
        continue;
      }
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('patience'), patienceMs);
        stream.once('drain', () => {
          clearTimeout(timer);
          resolve('drain');
        });
        stream.once('close', () => {
          clearTimeout(timer);
          resolve('closed');
        });
      });
      if (outcome !== 'drain') {
        return { sent, stalled: true, outcome };
      }
    }
    return { sent, stalled: false, outcome: 'completed' };
  }

  test('X8-4 出站停滞（对端零读取）：写入挂在 drain 上，server.timeout 仍在到期时触发并中断连接', async () => {
    const t = makeTimeline('X8-4');
    const seen = {};
    const TOTAL = 4 * 1024 * 1024;
    const wait = boundedWait(3000);
    const server = http.createServer(async (req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      res.writeHead(200, { 'content-length': String(TOTAL) });
      seen.result = await writeUntilStalled(res, { total: TOTAL, patienceMs: 1500 });
      t.record(`stalled(${seen.result.sent},${seen.result.outcome})`);
      wait.done();
    });
    server.timeout = 400;
    const port = await listen(server);
    const { socket } = await rawConnect(port, { head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n', mode: 'keep' });
    await wait.promise;
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    socket.destroy();
    expect(seen.result.stalled).toBe(true); // 写确实挂起：drain 未到
    expect(stream).toContain('sock.timeout'); // 停滞写入不重置闲置计时，计时照常到期
    expect(stream).toContain('socket.close');
    expect(stream).not.toContain('res.finish'); // 中断即终止，响应从未整份交入内核
  });

  test('X8-4 对照：server.timeout=0 时停滞的写入不被中断（httply 不计时则由配置决定）', async () => {
    const t = makeTimeline('X8-4-off');
    const seen = {};
    const TOTAL = 4 * 1024 * 1024;
    const wait = boundedWait(3000);
    const server = http.createServer(async (req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      res.writeHead(200, { 'content-length': String(TOTAL) });
      seen.result = await writeUntilStalled(res, { total: TOTAL, patienceMs: 1500 });
      t.record(`stalled(${seen.result.sent},${seen.result.outcome})`);
      wait.done();
    });
    const port = await listen(server);
    const { socket } = await rawConnect(port, { head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n', mode: 'keep' });
    await wait.promise;
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    socket.destroy();
    expect(seen.result.stalled).toBe(true);
    expect(seen.result.outcome).toBe('patience'); // 无计时介入，只能自己等超时
    expect(stream).not.toContain('sock.timeout');
    expect(stream).not.toContain('socket.close'); // 计时关掉就无人中断，连接停在挂起写入上
  });
});
