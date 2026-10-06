import http from 'node:http';
import net from 'node:net';
import { describe, expect, test } from 'vitest';

import { boundedWait, closeAll, HEAD_KA, listen, makeTimeline, rawConnect, recordReq, recordRes, recordSocket, sleep } from './helpers.js';

/**
 * X7 回收的时机与后果（P5）
 * 判据是 Node 事实：finish 时刻流状态、销毁请求的后果、不消费 body 的连接占用
 * X9-2（不干预时的空闲回收时刻）与实现无关，用例在 x9-behavior-archive.test.js
 * X7-5（keep-alive 第二请求的回收判定）并入 spec/x6-misuse.test.js 的 X6-2
 */
describe('X7 回收的时机与后果', () => {
  test('X7-1 截断未消费的 body 占用 keep-alive 连接，后续请求不被处理', async () => {
    const t = makeTimeline('X7-1a');
    const seen = { count: 0 };
    const server = http.createServer((req, res) => {
      seen.count += 1;
      recordReq(req, t, { data: false });
      recordSocket(req.socket, t);
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    server.keepAliveTimeout = 1000;
    const port = await listen(server);
    const { socket, state } = await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 1000\r\n\r\n',
      body: 'x'.repeat(40),
      mode: 'keep',
      readResponse: true
    });
    await sleep(150);
    socket.write('GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    await sleep(1500);
    t.dump();
    const firstResponse = state.response;
    const responses = (firstResponse.match(/HTTP\/1\.1 200/g) || []).length;
    closeAll(server);
    socket.destroy();
    expect(seen.count).toBe(1); // 第二请求未被处理，被残余 body 占用
    expect(responses).toBe(1);
  });

  test('X7-1 body 发全不消费：连接照常复用，第二请求被处理', async () => {
    const t = makeTimeline('X7-1b');
    const seen = { count: 0 };
    const server = http.createServer((req, res) => {
      seen.count += 1;
      recordReq(req, t, { data: false });
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    const port = await listen(server);
    const { socket, state } = await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 40\r\n\r\n',
      body: 'x'.repeat(40),
      mode: 'keep',
      readResponse: true
    });
    await sleep(150);
    socket.write('GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    await sleep(400);
    t.dump();
    const responses = (state.response.match(/HTTP\/1\.1 200/g) || []).length;
    closeAll(server);
    socket.destroy();
    expect(seen.count).toBe(2);
    expect(responses).toBe(2);
  });

  test('X7-2 finish 时刻 readableEnded/complete 可为 false，延后一个 tick 才为 true', async () => {
    const t = makeTimeline('X7-2');
    const seen = {};
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
      res.on('finish', () => {
        seen.atFinish = { ended: req.readableEnded, complete: req.complete };
        setImmediate(() => {
          seen.atNextTick = { ended: req.readableEnded, complete: req.complete };
          done();
        });
      });
    });
    let doneRef;
    const done = () => doneRef();
    const port = await listen(server);
    await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 30\r\n\r\n',
      body: 'x'.repeat(30),
      mode: 'keep',
      readResponse: true
    });
    await new Promise((resolve) => {
      doneRef = resolve;
      setTimeout(resolve, 2000);
    });
    t.dump();
    closeAll(server);
    // 回收判据只能延后一个 tick 取的直接依据
    expect(seen.atFinish.ended).toBe(false);
    expect(seen.atFinish.complete).toBe(false);
    expect(seen.atNextTick.ended).toBe(true);
    expect(seen.atNextTick.complete).toBe(true);
  });

  test('X7-3 响应已交内核后销毁请求：客户端完整收到，socket 干净关闭非 RST', async () => {
    const t = makeTimeline('X7-3');
    const CONTENT = 'y'.repeat(200);
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      res.writeHead(200, { 'content-length': String(Buffer.byteLength(CONTENT)) });
      res.end(CONTENT);
      res.on('finish', () => {
        setImmediate(() => {
          t.record('server.req.destroy');
          req.destroy(); // 模拟 httply 回收：body 截断未消费
        });
      });
    });
    const port = await listen(server);
    const { state } = await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 100\r\n\r\n',
      body: 'x'.repeat(40),
      mode: 'keep',
      readResponse: true
    });
    await sleep(300);
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    expect(stream).toContain('res.finish');
    expect(stream).toContain('req.aborted'); // destroy 派发 aborted
    expect(stream).toContain('socket.close(hadError=false)');
    expect(state.response).toContain('200 OK');
    expect(state.received).toBeGreaterThanOrEqual(200 + Buffer.byteLength('HTTP/1.1 200 OK\r\n') + Buffer.byteLength('content-length: 3\r\n\r\n'));
    expect(state.response).toContain(CONTENT);
  });

  // 四种形态逐条构造：GET 无 body、HEAD、Content-Length: 0 属「无 body 可读」，body 发全不消费属「已收全」
  // 四种都不该触发 httply 的回收销毁，连接都能续用第二个请求
  test('X7-4 GET / HEAD / Content-Length: 0 / body 发全四种形态：不触发回收销毁，连接照常复用', async () => {
    const forms = [
      { name: 'GET', head: HEAD_KA('GET'), body: '' },
      { name: 'HEAD', head: HEAD_KA('HEAD'), body: '' },
      { name: 'CL0', head: HEAD_KA('POST', 'Content-Length: 0\r\n'), body: '' },
      { name: 'full', head: HEAD_KA('POST', 'Content-Length: 40\r\n'), body: 'x'.repeat(40) }
    ];
    const observed = {};
    for (const form of forms) {
      const t = makeTimeline(`X7-4-${form.name}`);
      const seen = { count: 0, aborted: false };
      const wait = boundedWait(2000);
      const server = http.createServer((req, res) => {
        seen.count += 1;
        recordReq(req, t, { data: false });
        req.on('aborted', () => {
          seen.aborted = true;
        });
        res.writeHead(200, { 'content-length': '2' });
        res.end('ok');
        if (req.url === '/second') {
          res.on('finish', () => {
            setImmediate(() => {
              seen.flags = {
                ended: req.readableEnded,
                complete: req.complete,
                didRead: req.readableDidRead,
                flowing: req.readableFlowing
              };
              wait.done();
            });
          });
        }
      });
      const port = await listen(server);
      const { socket } = await rawConnect(port, { head: form.head, body: form.body, mode: 'keep' });
      await sleep(80);
      socket.write('GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
      await wait.promise;
      t.dump();
      closeAll(server);
      socket.destroy();
      observed[form.name] = seen;
    }
    for (const { name } of forms) {
      const seen = observed[name];
      expect(seen.flags, name).toBeDefined(); // 窗内未见第二请求即判为连接被占用
      expect(seen.count, name).toBe(2);
      expect(seen.aborted, name).toBe(false);
      expect(seen.flags.ended, name).toBe(true);
      expect(seen.flags.complete, name).toBe(true);
    }
    // 无 body 可读的形态下 didRead 保持 false 而 flowing 为 true：响应后读取要把两个标志位一起读（X2-5）
    expect(observed.GET.flags.didRead).toBe(false);
    expect(observed.GET.flags.flowing).toBe(true);
  });
});
