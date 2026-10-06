import http from 'node:http';
import { describe, expect, test } from 'vitest';

import { closeAll, listen, makeTimeline, rawConnect, recordReq, recordRes, recordSocket, sleep } from './helpers.js';

/**
 * X4 断连后写入信号的退化（P3 P4）
 */
describe('X4 断连后写入信号的退化', () => {
  test('X4-1 X4-2 断连后 write 返回 false、end 回调不触发；状态位失真', async () => {
    const t = makeTimeline('X4-1');
    const seen = {};
    const server = http.createServer(async (req, res) => {
      seen.res = res;
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      await sleep(200);
      seen.wrote = res.write('x'.repeat(1024));
      res.end('tail', () => {
        seen.endCb = true;
        t.record('res.end.callback');
      });
      await sleep(200);
      seen.ended = res.writableEnded;
      seen.finished = res.writableFinished;
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
    closeAll(server);
    expect(stream).toContain('res.close');
    expect(stream).not.toContain('res.finish');
    expect(seen.wrote).toBe(false);
    expect(seen.endCb).toBeUndefined();
    // 断连后不再派发 drain：实现若依靠 drain 继续写入会永久挂起，只能依据终止事件
    expect(stream).not.toContain('res.drain');
    // finish 未触发，两位却为 true：完整性只能认事件不能认状态位
    expect(seen.ended).toBe(true);
    expect(seen.finished).toBe(true);
  });

  test('X4-3 响应正常完成后 destroyed 亦为 true：单看 destroyed 判不出断连', async () => {
    const t = makeTimeline('X4-3');
    const seen = {};
    const server = http.createServer(async (req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      res.writeHead(200, { 'content-length': '5' });
      res.end('hello');
      await sleep(120);
      seen.destroyed = res.destroyed;
      seen.ended = res.writableEnded;
      seen.finishSeen = t.events.some((e) => e.startsWith('res.finish'));
      done();
    });
    let doneRef;
    const done = () => doneRef();
    const port = await listen(server);
    await rawConnect(port, { head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n', mode: 'keep' });
    await new Promise((resolve) => {
      doneRef = resolve;
      setTimeout(resolve, 2000);
    });
    t.dump();
    closeAll(server);
    expect(seen.finishSeen).toBe(true);
    expect(seen.destroyed).toBe(true); // 与断连路径同值，判定必须配 !writableEnded
    expect(seen.ended).toBe(true);
  });
});
