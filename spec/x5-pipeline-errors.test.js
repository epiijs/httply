import http from 'node:http';
import { pipeline } from 'node:stream';
import { describe, expect, test } from 'vitest';

import { closeAll, failingStream, listen, makeTimeline, rawConnect, recordReq, recordRes, recordSocket, slowStream, sleep } from './helpers.js';

/**
 * X5 失败的信号形态与归属（P3 P4）
 */
describe('X5 失败的信号形态与归属', () => {
  test('X5-1 目标已 destroyed 且未 writeHead：pipeline 同步抛 ERR_STREAM_UNABLE_TO_PIPE、不派发回调', async () => {
    const t = makeTimeline('X5-1a');
    const seen = {};
    const server = http.createServer(async (req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      await sleep(200);
      t.record('apply');
      try {
        pipeline(slowStream(50), res, () => {
          seen.cb = true;
          t.record('pipeline.callback');
        });
      } catch (error) {
        seen.threw = error.code;
        t.record(`pipeline.throw(${error.code})`);
      }
      await sleep(150);
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
    closeAll(server);
    expect(seen.threw).toBe('ERR_STREAM_UNABLE_TO_PIPE');
    expect(seen.cb).toBeUndefined();
  });

  test('X5-1 已 writeHead 且已发出数据后目标断连、再建 pipeline：仍同步抛，不派发回调（推翻「先 writeHead 则改由回调报错」的旧记录）', async () => {
    const t = makeTimeline('X5-1b');
    const seen = {};
    const server = http.createServer(async (req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      // 先 writeHead 并开始发送，60ms 时客户端断连；200ms 再建 pipeline
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('head-chunk');
      await sleep(200);
      t.record('apply');
      try {
        pipeline(slowStream(50), res, (error) => {
          seen.code = error?.code ?? null;
          seen.destroyed = res.destroyed;
          t.record(`pipeline.callback(${error?.code})`);
          done();
        });
      } catch (error) {
        seen.threw = error.code;
        t.record(`pipeline.throw(${error.code})`);
      }
      await sleep(150);
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
    closeAll(server);
    // 实测：writeHead 与否不改变形态——目标在 pipeline 建立前已毁即同步抛；旧断言的回调形态不存在
    expect(seen.threw).toBe('ERR_STREAM_UNABLE_TO_PIPE');
    expect(seen.code).toBeUndefined();
  });

  test('X5-1 X5-2 pipeline 在途时目标被服务端销毁：回调报 PREMATURE_CLOSE 而非 UNABLE_TO_PIPE', async () => {
    const t = makeTimeline('X5-1c');
    const seen = {};
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordSocket(req.socket, t);
      res.on('error', () => {});
      res.writeHead(200, { 'content-type': 'text/plain' });
      const source = slowStream(200, 1024, 5);
      pipeline(source, res, (error) => {
        seen.code = error?.code ?? null;
        seen.destroyed = res.destroyed;
        t.record(`pipeline.callback(${error?.code})`);
        done();
      });
      setTimeout(() => {
        t.record('server.res.destroy');
        res.destroy();
      }, 100);
    });
    let doneRef;
    const done = () => doneRef();
    const port = await listen(server);
    await rawConnect(port, { head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n', mode: 'keep' });
    await new Promise((resolve) => {
      doneRef = resolve;
      setTimeout(resolve, 3000);
    });
    t.dump();
    closeAll(server);
    // 目标侧在途销毁的回调码是 PREMATURE_CLOSE——UNABLE_TO_PIPE 只以同步抛形态存在
    expect(seen.code).toBe('ERR_STREAM_PREMATURE_CLOSE');
    expect(seen.destroyed).toBe(true);
  });

  test('X5-2 pipeline 中途断连：回调报 ERR_STREAM_PREMATURE_CLOSE，两侧 destroy', async () => {
    const t = makeTimeline('X5-2');
    const seen = {};
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      const source = slowStream(400, 1024, 10);
      source.on('error', () => {});
      pipeline(source, res, (error) => {
        seen.code = error?.code ?? null;
        seen.sourceDestroyed = source.destroyed;
        seen.resDestroyed = res.destroyed;
        t.record(`pipeline.callback(${error?.code})`);
        done();
      });
    });
    let doneRef;
    const done = () => doneRef();
    const port = await listen(server);
    await rawConnect(port, {
      head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n',
      mode: 'destroy',
      after: 120
    });
    await new Promise((resolve) => {
      doneRef = resolve;
      setTimeout(resolve, 4000);
    });
    t.dump();
    closeAll(server);
    expect(seen.code).toBe('ERR_STREAM_PREMATURE_CLOSE');
    expect(seen.resDestroyed).toBe(true);
    expect(seen.sourceDestroyed).toBe(true);
  });

  test('X5-3 源侧在 pipe 中途提前终止：回调报 PREMATURE_CLOSE，真实 ServerResponse 也被 pipeline 连带销毁（destroyed 已不足以判别来源）', async () => {
    const t = makeTimeline('X5-3a');
    const seen = {};
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      const source = slowStream(400, 1024, 10);
      source.on('error', () => {});
      pipeline(source, res, (error) => {
        seen.code = error?.code ?? null;
        seen.resDestroyed = res.destroyed;
        t.record(`pipeline.callback(${error?.code})`);
        done();
      });
      // 客户端不加干预，源流自行提前终止
      setTimeout(() => {
        t.record('source.destroy');
        source.destroy();
      }, 100);
    });
    let doneRef;
    const done = () => doneRef();
    const port = await listen(server);
    await rawConnect(port, { head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n', mode: 'keep' });
    await new Promise((resolve) => {
      doneRef = resolve;
      setTimeout(resolve, 3000);
    });
    t.dump();
    closeAll(server);
    expect(seen.code).toBe('ERR_STREAM_PREMATURE_CLOSE');
    // 实测结论：源流在 pipe 中途提前终止时，pipeline 把目标一并销毁，回调处 response.destroyed 为 true，
    // 与目标侧断连的形态相同。因此「配 response.destroyed 判来源」在这一路径上不成立，
    // 来源只能靠先行捕获源流事件区分（httply 的 sourceError 即此用途）
    expect(seen.resDestroyed).toBe(true);
  });

  test('X5-3 源在 pipeline 建立前已销毁：PREMATURE_CLOSE 于回调到达，目标销毁状态记录在案', async () => {
    const t = makeTimeline('X5-3b');
    const seen = {};
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      res.writeHead(200, { 'content-type': 'text/plain' });
      const source = slowStream(50, 1024, 5);
      source.destroy();
      pipeline(source, res, (error) => {
        seen.code = error?.code ?? null;
        seen.resDestroyed = res.destroyed;
        t.record(`pipeline.callback(${error?.code}) resDestroyed=${res.destroyed}`);
        done();
      });
    });
    let doneRef;
    const done = () => doneRef();
    const port = await listen(server);
    await rawConnect(port, { head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n', mode: 'keep' });
    await new Promise((resolve) => {
      doneRef = resolve;
      setTimeout(resolve, 2500);
    });
    t.dump();
    closeAll(server);
    expect(seen.code).toBe('ERR_STREAM_PREMATURE_CLOSE');
    // 实测发现：源在建立 pipeline 前已毁，pipeline 仍把目标连带销毁——「配 response.destroyed
    // 判来源」在真实 ServerResponse 上两个形态都为 true，判别式失效；来源区分只剩先行捕获源错误事件
    expect(seen.resDestroyed).toBe(true);
  });

  test('X5-4 源流真错误：pipeline 回调如实给业务错误，非 PREMATURE_CLOSE', async () => {
    const t = makeTimeline('X5-4');
    const seen = {};
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      pipeline(failingStream('source boom'), res, (error) => {
        seen.message = error?.message ?? null;
        seen.code = error?.code ?? null;
        t.record(`pipeline.callback(${error?.code || error?.message})`);
        done();
      });
    });
    let doneRef;
    const done = () => doneRef();
    const port = await listen(server);
    await rawConnect(port, { head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n', mode: 'keep' });
    await new Promise((resolve) => {
      doneRef = resolve;
      setTimeout(resolve, 2500);
    });
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    expect(seen.message).toBe('source boom');
    expect(stream).not.toContain('PREMATURE_CLOSE');
    // 先捕获源流错误，close 监听不覆盖它：res.close 可早于回调（见时间线），错误内容仍是源错误
    void stream;
  });

  test('X5-5 显式 res.destroy(error)：错误在 socket 层派发，res 的 error 事件不派发', async () => {
    const t = makeTimeline('X5-5');
    const seen = {};
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
      setTimeout(() => {
        t.record('server.res.destroy');
        res.destroy(new Error('boom'));
      }, 50);
      setTimeout(() => {
        seen.finishedSeen = t.events.some((e) => e.startsWith('res.finish'));
        done();
      }, 300);
    });
    let doneRef;
    const done = () => doneRef();
    const port = await listen(server);
    await rawConnect(port, { head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n', mode: 'keep' });
    await new Promise((resolve) => {
      doneRef = resolve;
      setTimeout(resolve, 2500);
    });
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    // 实测结论：destroy(error) 附带的错误由 socket 承接派发（socket.error），
    // res 自身的 error 事件不触发；req 侧派发 aborted 与 error(ECONNRESET)。
    // 「由 res.on('error') 承接本地错误」的假设在显式 destroy 形态下不成立
    expect(stream).toContain('socket.error(boom)');
    expect(stream).not.toContain('res.error');
    expect(stream).toContain('req.aborted');
    expect(seen.finishedSeen).toBe(false);
  });
});
