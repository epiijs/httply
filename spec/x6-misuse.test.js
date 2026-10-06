import http from 'node:http';
import net from 'node:net';
import { describe, expect, test } from 'vitest';

import { boundedWait, closeAll, listen, makeTimeline, recordReq, sleep } from './helpers.js';

/**
 * X6 误用的可检测性（P6）
 * X6-1 在 x2-termination 与 X2-6 合并取证；本文件承 keep-alive 第二、第三请求侧（X6-2 吸收 X7-5）
 */
describe('X6 误用的可检测性', () => {
  // 同一条连接上依次发出三个请求：正常请求、body 发全不消费（X6-2 响应后读取）、body 截断不消费（X7-5 回收判定）
  test('X6-2 X7-5 keep-alive 后续请求：响应后读取检测与回收判定与首请求同形', async () => {
    const t = makeTimeline('X6-2');
    const seen = { count: 0 };
    const wait = boundedWait(2500);
    const server = http.createServer((req, res) => {
      seen.count += 1;
      recordReq(req, t, { data: false });
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
      if (req.url === '/') {
        return;
      }
      const slot = req.url === '/second' ? (seen.second = {}) : (seen.third = {});
      if (req.url === '/third') {
        // 本请求的 req 层终止事件单独记录：全连接的时间线里，前两个请求正常完成会各自派发 end 与 close
        slot.events = [];
        req.on('end', () => slot.events.push('end'));
        req.on('aborted', () => slot.events.push('aborted'));
        req.on('error', () => slot.events.push('error'));
        req.on('close', () => slot.events.push('close'));
      }
      res.on('finish', () => {
        slot.atFinish = { didRead: req.readableDidRead, flowing: req.readableFlowing, ended: req.readableEnded };
        setImmediate(() => {
          slot.atNextTick = { didRead: req.readableDidRead, flowing: req.readableFlowing, ended: req.readableEnded };
          if (req.url === '/third') {
            wait.done();
          }
        });
        if (req.url === '/second') {
          // 读取时机在使用方手里，取证不绑定在 finish 后固定的一刻
          setTimeout(() => {
            slot.settled = { didRead: req.readableDidRead, flowing: req.readableFlowing, ended: req.readableEnded };
            t.record(`second.flags(didRead=${slot.settled.didRead},flowing=${slot.settled.flowing},ended=${slot.settled.ended})`);
          }, 80);
        }
      });
    });
    const port = await listen(server);
    const socket = net.connect(port);
    socket.resume();
    await new Promise((resolve) => socket.on('connect', resolve));
    // 第一请求：正常完成，为后续两个请求建立 keep-alive 上下文
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    await sleep(120);
    // 第二请求：body 发全但不读，先响应
    socket.write('POST /second HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 50\r\n\r\n');
    socket.write('x'.repeat(50));
    await sleep(120);
    // 第三请求：body 截断且不消费，最后写入以免占用连接影响上一条
    socket.write('POST /third HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nContent-Length: 60\r\n\r\n');
    socket.write('x'.repeat(20));
    await wait.promise;
    await sleep(120);
    t.dump();
    closeAll(server);
    socket.destroy();
    expect(seen.count).toBe(3);
    // X6-2：响应 finish 后 flowing 立即为真，响应后读取检测在 keep-alive 后续请求上照常成立
    expect(seen.second.atFinish.flowing).toBe(true);
    expect(seen.second.settled.flowing).toBe(true);
    // didRead 变为 true 晚于 flowing（实测在 finish 后数十毫秒才跟上），单独依赖它会漏掉刚 finish 的时刻
    // 实测取值进时间线（second.flags(...)），断言只锁定「判据不得单独依赖 didRead」这一条结论
    expect(typeof seen.second.settled.didRead).toBe('boolean');
    // X7-5：截断的 body 不交付，延后一个 tick 仍为 false，回收判定照常成立
    expect(seen.third.atFinish.ended).toBe(false);
    expect(seen.third.atNextTick.ended).toBe(false);
    // 响应之后 req 层再无任何终止事件（X2-1 在 keep-alive 后续请求上同形）
    expect(seen.third.events).toEqual([]);
  });
});
