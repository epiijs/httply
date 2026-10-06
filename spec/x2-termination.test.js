import http from 'node:http';
import { describe, expect, test } from 'vitest';

import { closeAll, listen, makeTimeline, rawConnect, recordReq, recordRes, recordSocket, sleep } from './helpers.js';

/**
 * X2 终止信号的到达组合（P2 P6）
 * 未响应断连 / 服务端 destroy / 连接终止后的 res 事件 / 响应 finish 的 flowing 丢弃 / 事后调用 / 短连接同形
 */
describe('X2 终止信号的到达组合', () => {
  test('X2-2 X1-4 未响应时客户端断连：aborted 与 error 先后都到、不互斥', async () => {
    const t = makeTimeline('X2-2');
    const seen = {};
    const server = http.createServer((req, res) => {
      seen.req = req;
      recordReq(req, t);
      recordRes(res, t);
      recordSocket(req.socket, t);
      // 不应答，等 body 期间客户端走
    });
    const port = await listen(server);
    await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 100\r\n\r\n',
      body: 'x'.repeat(40),
      mode: 'destroy',
      after: 60
    });
    await sleep(250);
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    expect(stream).toContain('req.aborted');
    expect(stream).toContain('req.error');
    expect(stream.indexOf('req.aborted')).toBeLessThan(stream.indexOf('req.error'));
    expect(stream).not.toContain('res.finish');
  });

  test('X2-3 服务端 req.destroy()：aborted 与 close 到，error 不到', async () => {
    const t = makeTimeline('X2-3');
    const server = http.createServer((req, res) => {
      recordReq(req, t);
      recordRes(res, t);
      recordSocket(req.socket, t);
      setTimeout(() => {
        t.record('server.req.destroy');
        req.destroy();
      }, 30);
    });
    const port = await listen(server);
    await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 100\r\n\r\n',
      body: 'x'.repeat(40),
      mode: 'keep'
    });
    await sleep(250);
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    expect(stream).toContain('req.aborted');
    expect(stream).toContain('req.close');
    expect(stream).not.toContain('req.error');
  });

  test('X2-4 X3-1 X3-5 X5-5a 写入前断连：close 只到一次且早于写入，res.finish/res.error 都不到', async () => {
    const t = makeTimeline('X2-4');
    const seen = {};
    const server = http.createServer(async (req, res) => {
      seen.res = res;
      recordReq(req, t, { data: false });
      recordSocket(req.socket, t);
      recordRes(res, t);
      await sleep(200);
      t.record('apply');
      // 终止已发生后再挂监听：收不到第二次 close（X3-1）
      res.on('close', () => t.record('res.close.late'));
      const wrote = res.write('x'.repeat(1024));
      seen.wrote = wrote;
      res.end('tail');
      await sleep(200);
      seen.finished = t.events.some((e) => e.startsWith('res.finish'));
      done();
    });
    let doneRef;
    const done = () => doneRef();
    const port = await listen(server);
    await rawConnect(port, {
      head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n',
      mode: 'destroy',
      after: 60
    });
    await new Promise((resolve) => {
      doneRef = resolve;
      setTimeout(resolve, 2500);
    });
    t.dump();
    const stream = t.events.join(' ');
    const snapshot = { wrote: seen.wrote, finished: seen.finished, destroyed: seen.res && seen.res.destroyed };
    closeAll(server);
    expect(stream).toContain('res.close');
    const closeCount = stream.split('res.close@').length - 1;
    expect(closeCount).toBe(1); // 只到一次
    expect(stream).not.toContain('res.close.late');
    expect(stream).not.toContain('res.finish');
    expect(stream).not.toContain('res.error'); // X5-5 前半：断连不触发 res.error
    expect(t.events.findIndex((e) => e.startsWith('res.close@')))
      .toBeLessThan(t.events.findIndex((e) => e.startsWith('apply@'))); // X3-5：close 早于写入
    expect(snapshot.destroyed).toBe(true);
    expect(snapshot.finished).toBe(false);
  });

  test('X2-5 响应 finish 后流状态：body 先于响应接收完毕时 readableDidRead 与 flowing 同时为 true', async () => {
    const t = makeTimeline('X2-5');
    const seen = {};
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      // 不读 body，直接应答
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
      res.on('finish', () => {
        setImmediate(() => {
          seen.afterRespond = { didRead: req.readableDidRead, flowing: req.readableFlowing, ended: req.readableEnded };
          done();
        });
      });
    });
    let doneRef;
    const done = () => doneRef();
    const port = await listen(server);
    // body 先写完，120ms 后响应才 finish，判定不至于抢时序
    await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 50\r\n\r\n',
      body: 'x'.repeat(50),
      mode: 'keep'
    });
    await new Promise((resolve) => {
      doneRef = resolve;
      setTimeout(resolve, 2500);
    });
    t.dump();
    const snapshot = seen.afterRespond;
    closeAll(server);
    // 响应 finish 后，Node 把请求流置为 flowing 并丢弃残余：晚访问读不到数据
    expect(snapshot.flowing).toBe(true);
    expect(snapshot.didRead).toBe(true);
    expect(snapshot.ended).toBe(true);
  });

  test('X2-5 body 晚于响应到达：单独判 readableDidRead 不成立，flowing 仍为 true（须并取两个标志位）', async () => {
    const t = makeTimeline('X2-5-late');
    const seen = {};
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
      res.on('finish', () => {
        setImmediate(() => {
          seen.atFinish = { didRead: req.readableDidRead, flowing: req.readableFlowing };
        });
      });
      setTimeout(() => {
        seen.late = { didRead: req.readableDidRead, flowing: req.readableFlowing };
        done();
      }, 500);
    });
    let doneRef;
    const done = () => doneRef();
    const port = await listen(server);
    const { socket } = await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 50\r\n\r\n',
      mode: 'keep'
    });
    await sleep(120);
    // 响应已 finish，body 此刻才到达：Node 丢弃残余并置 flowing
    socket.write('x'.repeat(50));
    await new Promise((resolve) => {
      doneRef = resolve;
      setTimeout(resolve, 2500);
    });
    t.dump();
    closeAll(server);
    expect(seen.atFinish.didRead).toBe(false);
    // 晚到的 body 被丢弃后 didRead 仍为 false，只有 flowing 已为 true，故首次访问要两个标志位一起读（X2-5）
    expect(seen.late.didRead).toBe(false);
    expect(seen.late.flowing).toBe(true);
  });

  test('X2-6 X6-1 完成后的 res.end/write 静默无效；重复 writeHead 同步抛 ERR_HTTP_HEADERS_SENT', async () => {
    const t = makeTimeline('X2-6');
    const seen = {};
    const server = http.createServer(async (req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
      await sleep(60);
      try {
        res.end('again');
      } catch (error) {
        t.record(`end.throws(${error.code})`);
      }
      try {
        res.write('more');
      } catch (error) {
        t.record(`write.throws(${error.code})`);
      }
      try {
        res.writeHead(500);
      } catch (error) {
        seen.second = error.code;
        t.record(`writeHead.throws(${error.code})`);
      }
      await sleep(100);
      done();
    });
    let doneRef;
    const done = () => doneRef();
    const port = await listen(server);
    await rawConnect(port, { head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n', mode: 'keep' });
    await new Promise((resolve) => {
      doneRef = resolve;
      setTimeout(resolve, 1500);
    });
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    expect(stream).toContain('res.finish');
    expect(stream).not.toContain('res.error');
    expect(stream).not.toContain('end.throws');
    expect(stream).not.toContain('write.throws');
    expect(seen.second).toBe('ERR_HTTP_HEADERS_SENT');
  });

  test('X2-7 X3-6 短连接（Connection: close）：正常完成 finish→close 同形，close 只到一次', async () => {
    const t = makeTimeline('X2-7-normal');
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      res.end('small');
    });
    const port = await listen(server);
    const { state } = await rawConnect(port, { head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', mode: 'keep', readResponse: true });
    await sleep(400);
    t.dump();
    const stream = t.events.join(' ');
    const closeCount = (stream.match(/res\.close@/g) || []).length;
    closeAll(server);
    expect(state.response).toContain('200');
    expect(closeCount).toBe(1);
    expect(t.events.findIndex((e) => e.startsWith('res.finish@')))
      .toBeLessThan(t.events.findIndex((e) => e.startsWith('res.close@')));
  });

  test('X2-7 短连接：写入前断连时 res 侧终止组合是否与 keep-alive 同形', async () => {
    const t = makeTimeline('X2-7-abort');
    const server = http.createServer(async (req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      await sleep(200);
      t.record('apply');
      res.end('late');
      await sleep(150);
      done();
    });
    let doneRef;
    const done = () => doneRef();
    const port = await listen(server);
    await rawConnect(port, {
      head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
      mode: 'destroy',
      after: 60
    });
    await new Promise((resolve) => {
      doneRef = resolve;
      setTimeout(resolve, 2500);
    });
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    // 与 keep-alive 同形：只有 close、无 finish、无 error，且 close 早于 apply
    expect(stream).toContain('res.close');
    expect(stream).not.toContain('res.finish');
    expect(stream).not.toContain('res.error');
  });

  test('X2-8 短连接：响应后截断时 req 层无终止事件、socket 层组合与 keep-alive 不同形', async () => {
    const t = makeTimeline('X2-8-trunc');
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      res.writeHead(200, { 'content-length': '5' });
      res.end('hello');
    });
    const port = await listen(server);
    await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 100\r\n\r\n',
      body: 'x'.repeat(40),
      mode: 'fin',
      after: 120
    });
    await sleep(300);
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    // req 层无终止事件与 socket close 可达两条与 keep-alive 同形（X2-1、X3-2）
    expect(stream).toContain('res.finish');
    expect(stream).toContain('socket.close');
    expect(stream).not.toContain('req.aborted');
    expect(stream).not.toContain('req.error');
    expect(stream).not.toContain('req.end');
    // 但 socket 层组合不同形：短连接下 Node 在 finish 时刻即关闭连接，截断根本不在观察时间内发生
    // （keep-alive 形态为 end→error(HPE_INVALID_EOF_STATE)→close(hadError=true)，见 X1-1）
    // 差异登记在报告「结论更新记录」，对 P2/P3 承诺无影响（终止信号仍在）
    expect(stream).not.toContain('socket.error');
    expect(stream).toContain('socket.close(hadError=false)');
  });
});
