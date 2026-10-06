import http from 'node:http';
import { describe, expect, test } from 'vitest';

import { closeAll, HEAD_KA, listen, makeTimeline, rawConnect, recordReq, recordRes, recordSocket, sleep } from './helpers.js';

/**
 * X9 行为留档：结论不改变 httply 的行为定义与实现
 *
 * 收留三类行为：文档已经写明、读一次就够的事实；历史上出过争议或被误用过的判断；承诺面之外的边界。
 * 它们不支撑任何实现分支，也不进入承诺措辞，因此不参与每轮全量，由 `spec/vitest.config.x9.ts` 单独运行，
 * 在 Node 大版本升级或该行结论被质疑时重跑。取舍标准见 design-node-test.md「规则的取舍」。
 */
describe('X9 行为留档', () => {
  // X9-1 请求行与头解析失败发生在 handler 之前，httply 拿不到 req/res，无从参与。
  // 留下的理由是它是代理与转发类实现常问的边界：handler 之前唯一的介入点是 server 级 clientError
  test('X9-1 畸形请求行：handler 不触发，客户端收到 400，连接被处置', async () => {
    const t = makeTimeline('X9-1a');
    const seen = { count: 0 };
    const server = http.createServer((req, res) => {
      seen.count += 1;
      t.record('request');
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    const port = await listen(server);
    const { state } = await rawConnect(port, { head: 'BAD METHOD WITH SPACES / HTTP/1.1\r\n\r\n', mode: 'keep', readResponse: true });
    await sleep(400);
    t.dump();
    const response = state.response;
    closeAll(server);
    expect(seen.count).toBe(0); // handler 之前即失败
    expect(response).toMatch(/HTTP\/1\.1 400/);
    expect(state.closed || response.toLowerCase().includes('connection: close')).toBe(true);
  });

  test('X9-1 坏 Content-Length：同样 400，handler 不触发', async () => {
    const t = makeTimeline('X9-1b');
    const seen = { count: 0 };
    const server = http.createServer((req, res) => {
      seen.count += 1;
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    const port = await listen(server);
    const { state } = await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: abc\r\n\r\n',
      mode: 'keep',
      readResponse: true
    });
    await sleep(400);
    t.dump();
    const response = state.response;
    closeAll(server);
    expect(seen.count).toBe(0);
    expect(response).toMatch(/HTTP\/1\.1 400/);
  });

  // 要判的是「消息层有无介入路径」。实测：handler 之前唯一的官方钩子是 server 级 clientError
  // （只有 socket、无 req/res），注册它即接管 Node 默认的 400/431 处置
  test('X9-1 clientError 是解析失败的介入路径：接管后默认 400 不再发出，可自行处置', async () => {
    const t = makeTimeline('X9-1-hook');
    const seen = { count: 0, codes: [] };
    const server = http.createServer((req, res) => {
      seen.count += 1;
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    server.on('clientError', (error, socket) => {
      seen.codes.push(error.code);
      t.record(`clientError(${error.code},bytesParsed=${error.bytesParsed},rawPacket=${error.rawPacket.length})`);
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 451 Unavailable For Legal Reasons\r\nConnection: close\r\n\r\n');
      }
    });
    const port = await listen(server);
    const { state } = await rawConnect(port, { head: 'BAD METHOD WITH SPACES / HTTP/1.1\r\n\r\n', mode: 'keep', readResponse: true });
    await sleep(400);
    t.dump();
    closeAll(server);
    expect(seen.count).toBe(0); // 仍在 handler 之前
    expect(seen.codes).toContain('HPE_INVALID_METHOD');
    expect(state.response).toContain('451'); // 处置权已在用户手里
    expect(state.response).not.toContain('400'); // 默认的 400 被接管掉
  });

  test('X9-1 头部字段超限：默认处置为 431（HPE_HEADER_OVERFLOW），handler 不触发', async () => {
    const seen = { count: 0 };
    const t = makeTimeline('X9-1-overflow');
    const server = http.createServer((req, res) => {
      seen.count += 1;
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    const port = await listen(server);
    const { state } = await rawConnect(port, {
      head: `POST / HTTP/1.1\r\nHost: localhost\r\nX: ${'a'.repeat(200 * 1024)}\r\n\r\n`,
      mode: 'keep',
      readResponse: true
    });
    await sleep(400);
    t.dump();
    closeAll(server);
    expect(seen.count).toBe(0);
    expect(state.response).toMatch(/HTTP\/1\.1 431/);
    expect(state.response.toLowerCase()).toContain('connection: close');
  });

  // X9-2 keepAliveTimeout 到期后 Node 自行回收被占用的连接。回收时刻由 http.md 成文的公式
  // keepAliveTimeout + keepAliveTimeoutBuffer 决定（buffer 自 v24.6.0 起列出，默认 1000）；
  // httply 回收只销毁未读完的请求，不依赖 Node 何时自行释放连接
  test('X9-2 截断未消费的 body 占用连接：keepAliveTimeout 到期由 Node 自行回收，无需使用方动作', async () => {
    const t = makeTimeline('X9-2a');
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      // 未做配置的 server：不读 body、不 destroy，只看 Node 自己是否回收
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    server.keepAliveTimeout = 200;
    const port = await listen(server);
    const { socket, state } = await rawConnect(port, {
      head: HEAD_KA('POST', 'Content-Length: 1000\r\n'),
      body: 'x'.repeat(40),
      mode: 'keep',
      readResponse: true
    });
    // 观察时间取 keepAliveTimeout 的十倍以上：实测回收落在 200 + 缓冲 1000 之后
    await sleep(2500);
    t.dump();
    const stream = t.events.join(' ');
    const closeIndex = t.events.findIndex((e) => e.startsWith('socket.close'));
    closeAll(server);
    socket.destroy();
    expect(stream).toContain('res.finish'); // 响应已 finish
    expect(closeIndex).toBeGreaterThanOrEqual(0); // 未被使用方干预，Node 自行回收该连接
    expect(t.events[closeIndex]).toContain('hadError=false'); // 干净关闭，非 RST
    expect(Number(t.events[closeIndex].split('@')[1])).toBeGreaterThan(200);
    expect(state.response).toContain('200'); // 回收不影响已交内核的响应送达
  });

  test('X9-2 keepAliveTimeout=0：占用连接的截断 body 不被回收', async () => {
    const t = makeTimeline('X9-2b');
    const server = http.createServer((req, res) => {
      recordReq(req, t, { data: false });
      recordRes(res, t);
      recordSocket(req.socket, t);
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    server.keepAliveTimeout = 0;
    const port = await listen(server);
    const { socket } = await rawConnect(port, {
      head: HEAD_KA('POST', 'Content-Length: 1000\r\n'),
      body: 'x'.repeat(40),
      mode: 'keep'
    });
    // 负向断言：取上一用例实测回收时刻（约 1200ms）的两倍观察时间，未见即判为未发生
    await sleep(2500);
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    socket.destroy();
    expect(stream).toContain('res.finish');
    expect(stream).not.toContain('socket.close'); // keepAliveTimeout=0 关掉该路径，连接只能由使用方或 server.timeout 收
  });

  // X9-3 两条路径都不读 hadError，本行不支撑任何判据。留下的理由是它被误用过：
  // 见到 hadError=true 就断定客户端违约。实测两种终止同为 true，含义只有「终止时是否伴随解析错误」
  test('X9-3 客户端以 FIN 终止未发完的 body：socket.close 到达，且残余 body 使 hadError 为 true', async () => {
    const t = makeTimeline('X9-3-fin');
    const seen = {};
    const server = http.createServer((req, res) => {
      recordReq(req, t);
      recordRes(res, t);
      recordSocket(req.socket, t);
      req.socket.on('close', (hadError) => {
        seen.hadError = hadError;
      });
    });
    const port = await listen(server);
    await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 100\r\n\r\n',
      body: 'x'.repeat(40),
      mode: 'fin',
      after: 80
    });
    await sleep(250);
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    expect(stream).toContain('req.aborted');
    expect(stream).toContain('socket.close'); // 终止信号到达
    // hadError=true 与 RST 组同值，故它不区分优雅关闭与复位
    expect(seen.hadError).toBe(true);
  });

  test('X9-3 客户端以 RST 终止未发完的 body：socket.close 同样到达，信号与 FIN 同形', async () => {
    const t = makeTimeline('X9-3-rst');
    const seen = {};
    const server = http.createServer((req, res) => {
      recordReq(req, t);
      recordRes(res, t);
      recordSocket(req.socket, t);
      req.socket.on('close', (hadError) => {
        seen.hadError = hadError;
      });
    });
    const port = await listen(server);
    await rawConnect(port, {
      head: 'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 100\r\n\r\n',
      body: 'x'.repeat(40),
      mode: 'rst',
      after: 80
    });
    await sleep(250);
    t.dump();
    const stream = t.events.join(' ');
    closeAll(server);
    expect(stream).toContain('socket.close');
    expect(seen.hadError).toBe(true);
  });

  // X9-4 server 计时属性的默认值。六项全部由 http.md 逐项列出，httply 不持时钟，读一次即可引用。
  // 留下的理由是默认值本身会变：timeout 自 v13.0.0 由 120s 改为 0，keepAliveTimeoutBuffer 自 v24.6.0 才成文
  test('X9-4 新建 server 的各计时属性默认值与文档一致', async () => {
    const server = http.createServer();
    expect(server.keepAliveTimeout).toBe(5000);
    expect(server.keepAliveTimeoutBuffer).toBe(1000);
    expect(server.requestTimeout).toBe(300000);
    expect(server.headersTimeout).toBe(60000);
    expect(server.connectionsCheckingInterval).toBe(30000);
    expect(server.timeout).toBe(0);
  });

  // X9-5（应答 Connection 的取值历史争议）与 X9-6（不设用例的豁免登记）两行没有对应用例：
  // 前者的观察顺带在 X1-3 的用例里取证，后者只需在方案表里登记理由
});
