import http from 'node:http';
import { describe, expect, test } from 'vitest';

import { closeAll, listen, makeTimeline, rawConnect, recordReq, recordRes, recordSocket, sleep } from './helpers.js';

/**
 * X1 请求体完整接收的判定（P1）
 * `Content-Length` 定长界定下截断的可感知路径、chunked 未发送终止块、任意 method 均正常派发
 */
describe('X1 请求体完整接收的判定', () => {
  test('X1-1 X2-1 X3-2 响应后截断：req 层零终止事件，只剩 socket 层 end→error→close', async () => {
    const t = makeTimeline('X1-1');
    const seen = {};
    const server = http.createServer((req, res) => {
      t.record('request');
      seen.req = req;
      recordReq(req, t);
      recordRes(res, t);
      recordSocket(req.socket, t);
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    const port = await listen(server);
    await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 100\r\n\r\n',
      body: 'x'.repeat(40),
      mode: 'fin',
      after: 120
    });
    await sleep(250);
    t.dump();
    const stream = t.events.join(' ');
    const flags = { complete: seen.req.complete, ended: seen.req.readableEnded };
    closeAll(server);
    expect(stream).toContain('res.finish');
    // 响应 finish 后 req 层不再派发终止事件（X2-1）：截断只能由 socket 层感知
    expect(stream).not.toContain('req.end');
    expect(stream).not.toContain('req.close');
    expect(stream).not.toContain('req.aborted');
    expect(stream).toContain('socket.end');
    expect(stream).toContain('socket.error(HPE_INVALID_EOF_STATE)');
    expect(stream).toContain('socket.close'); // socket close 作为终止信号可达（X3-2）
    expect(flags.complete).toBe(false);
    expect(flags.ended).toBe(false);
  });

  test('X1-2 chunked 未发送终止块：end 不触发、流不会自然接收完整，连接保持时永无终止事件', async () => {
    const t = makeTimeline('X1-2');
    const seen = {};
    const server = http.createServer((req, res) => {
      seen.req = req;
      recordReq(req, t);
      recordRes(res, t);
      recordSocket(req.socket, t);
      // 不应答不读尽：观察流自身的终止信号是否到达
    });
    const port = await listen(server);
    await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nTransfer-Encoding: chunked\r\n\r\n',
      body: '10\r\n' + 'x'.repeat(16) + '\r\n',
      mode: 'keep'
    });
    await sleep(800);
    t.dump();
    const stream = t.events.join(' ');
    const flags = { complete: seen.req.complete, ended: seen.req.readableEnded };
    closeAll(server);
    expect(stream).toContain('req.data(16)');
    expect(stream).not.toContain('req.end');
    expect(stream).not.toContain('req.close');
    expect(flags.complete).toBe(false);
    expect(flags.ended).toBe(false);
  });

  // X9-5（应答 Connection 的取值）与实现无关，观察在本条内顺带取证，不另立用例
  test('X1-3 X9-5 GET / DELETE / OPTIONS 带完整 body：不按 method 拦截，两种界定方式均接收完整、应答 keep-alive', async () => {
    const t = makeTimeline('X1-3');
    const perMethod = {};
    const server = http.createServer((req, res) => {
      const slot = perMethod[req.method] = { bytes: 0, ended: false, complete: false };
      recordReq(req, t, { data: false });
      req.on('data', (chunk) => {
        slot.bytes += chunk.length;
      });
      req.on('end', () => {
        slot.ended = true;
        slot.complete = req.complete;
        res.writeHead(200, { 'content-length': '2' });
        res.end('ok');
      });
    });
    const port = await listen(server);
    const chunked = '10\r\n' + 'x'.repeat(16) + '\r\n0\r\n\r\n';
    const forms = [
      { method: 'GET', framing: 'Content-Length: 10\r\n\r\n', body: 'x'.repeat(10), expected: 10 },
      { method: 'DELETE', framing: 'Transfer-Encoding: chunked\r\n\r\n', body: chunked, expected: 16 },
      { method: 'OPTIONS', framing: 'Transfer-Encoding: chunked\r\n\r\n', body: chunked, expected: 16 }
    ];
    const states = [];
    for (const form of forms) {
      const { state } = await rawConnect(port, {
        head: `${form.method} / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n${form.framing}`,
        body: form.body,
        mode: 'keep',
        readResponse: true
      });
      states.push(state);
      await sleep(150);
    }
    t.dump();
    closeAll(server);
    for (const [i, form] of forms.entries()) {
      const slot = perMethod[form.method];
      const response = states[i].response;
      expect(slot, form.method).toBeDefined();
      // 服务端照常派发请求体，不因 method 而拦截（GET 走定长、其余两种走 chunked）
      expect(slot.ended, form.method).toBe(true);
      expect(slot.bytes, form.method).toBe(form.expected);
      expect(slot.complete, form.method).toBe(true);
      // X9-5：完整 chunked（含终止块）的应答实测为 keep-alive，旧报告记的
      // 「Connection: close + HPE_CLOSED_CONNECTION」在此形态不复现，现象归因 Node v10/v11 客户端缺陷
      expect(response, form.method).toContain('200');
      expect(response.toLowerCase(), form.method).toContain('connection: keep-alive');
    }
  });
});
