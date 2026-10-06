import http from 'node:http';
import { describe, expect, test } from 'vitest';

import { closeAll, listen, makeTimeline, rawConnect, recordReq, sleep } from './helpers.js';

/**
 * X3 socket close 作为终止信号的资格（P2 P3）
 * X3-1 在 x2-termination 与 X2-4 合并取证；X3-2 在 x1-body-framing 与 X1-1 合并取证
 * X9-3（hadError 的含义）与实现无关，用例在 x9-behavior-archive.test.js
 */
describe('X3 socket close 作为终止信号的资格', () => {
  test('X3-3 响应发出前的各类终止形态：socket close 是否都到达', async () => {
    const t = makeTimeline('X3-3');
    const forms = {};
    const server = http.createServer((req, res) => {
      const slot = forms[req.url] = { reqAborted: false, reqClose: false, socketClose: false, hadError: null };
      recordReq(req, t, { data: false });
      req.on('aborted', () => {
        slot.reqAborted = true;
      });
      req.on('close', () => {
        slot.reqClose = true;
      });
      req.socket.on('close', (hadError) => {
        slot.socketClose = true;
        slot.hadError = hadError;
        t.record(`${req.url}.socket.close(hadError=${hadError})`);
      });
      // /destroy 由服务端销毁请求流，keep-alive 连接是否随之终止是本行的关键一问
      if (req.url === '/destroy') {
        setTimeout(() => req.destroy(), 30);
      }
      // 其余形态不应答：只观察请求流终止时 socket 层是否同步终止
    });
    const port = await listen(server);
    const head = (url) => `POST ${url} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 100\r\n\r\n`;
    await rawConnect(port, { head: head('/fin'), body: 'x'.repeat(40), mode: 'fin', after: 80 });
    await rawConnect(port, { head: head('/rst'), body: 'x'.repeat(40), mode: 'rst', after: 80 });
    await rawConnect(port, { head: head('/destroy'), body: 'x'.repeat(40), mode: 'keep' });
    await sleep(400);
    t.dump();
    closeAll(server);
    // 三种形态三种形态都以 socket close 终止，说明读取侧只靠 socket close 即可保证终止必被感知
    for (const url of ['/fin', '/rst', '/destroy']) {
      expect(forms[url], url).toBeDefined();
      expect(forms[url].reqAborted, url).toBe(true);
      expect(forms[url].socketClose, url).toBe(true);
    }
  });

  test('X3-4 keep-alive 正常完成：close 紧跟 finish，此刻 socket 仍可写', async () => {
    const t = makeTimeline('X3-4');
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      const sock = req.socket;
      res.on('finish', () => t.record('res.finish'));
      res.on('close', () => t.record(`res.close(writable=${sock.writable})`));
      res.end('small');
    });
    const port = await listen(server);
    await rawConnect(port, { head: 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n', mode: 'keep' });
    await sleep(300);
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    expect(stream).toContain('res.finish');
    expect(stream).toContain('res.close(writable=true)');
    expect(t.events[0]).toMatch(/^res\.finish/);
    expect(t.events[1]).toMatch(/^res\.close/);
  });
});
