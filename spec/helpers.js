import net from 'node:net';
import { Readable } from 'node:stream';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 有界等待：预期事件到齐即调用 done() 提前返回，ms 只作上界（用例要求第 1 条）
// 负向断言没有到达信号，等满上界仍未见事件即判为未发生
export function boundedWait(ms) {
  let done;
  const promise = new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    done = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, done };
}

export function slowStream(total = 400, chunkSize = 1024, delay = 1) {
  let sent = 0;
  return Readable.from((async function* () {
    while (sent < total) {
      sent += 1;
      yield Buffer.alloc(chunkSize, 0x78);
      if (delay) {
        await sleep(delay);
      }
    }
  })());
}

export function failingStream(message = 'source boom') {
  return Readable.from((async function* () {
    yield Buffer.from('partial');
    throw new Error(message);
  })());
}

// 时间线：每行「事件@毫秒」，输出即证据（构造约束原则 6）
export function makeTimeline(title) {
  const t0 = Date.now();
  const events = [];
  return {
    events,
    record(name) {
      events.push(`${name}@${Date.now() - t0}`);
    },
    dump() {
      console.log(`[${title}] ${events.join(' ')}`);
    }
  };
}

// data 监听会把流入站置为 flowing，观测流状态的用例必须自己决定是否挂（原则 3）
export function recordReq(req, t, { data = true } = {}) {
  if (data) {
    let first = false;
    req.on('data', (chunk) => {
      if (!first) {
        first = true;
        t.record(`req.data(${chunk.length})`);
      }
    });
  }
  req.on('end', () => t.record('req.end'));
  req.on('aborted', () => t.record('req.aborted'));
  req.on('error', (error) => t.record(`req.error(${error.code || error.message})`));
  req.on('close', () => t.record('req.close'));
}

export function recordRes(res, t) {
  res.on('finish', () => t.record('res.finish'));
  res.on('close', () => t.record('res.close'));
  res.on('error', (error) => t.record(`res.error(${error.code || error.message})`));
  // 断连后是否仍派发 drain，决定实现能否依靠 drain 继续写入（X4-1）
  res.on('drain', () => t.record('res.drain'));
}

export function recordSocket(socket, t) {
  socket.on('timeout', () => t.record('sock.timeout'));
  socket.on('end', () => t.record('socket.end'));
  socket.on('error', (error) => t.record(`socket.error(${error.code || error.message})`));
  socket.on('close', (hadError) => t.record(`socket.close(hadError=${hadError})`));
}

export function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
}

export function closeAll(server) {
  server.close();
  server.closeAllConnections();
}

// mode: keep 保持连接 | fin 定时 end() | rst 定时 resetAndDestroy() | destroy 定时 destroy() | read 正常读完不关
// after 为写头之后的毫秒数；abort-on-first-byte 收到首个响应字节即 destroy
// data 监听只在需要消费响应时挂：不挂则内核接收窗占满、对端零推进（X8-4 停滞形态）
export function rawConnect(port, { head, body = '', mode = 'keep', after = 0, readResponse = false } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port);
    const state = { received: 0, response: '', closed: false, error: null };
    socket.on('error', (error) => {
      state.error = error.code || error.message;
    });
    socket.on('close', () => {
      state.closed = true;
    });
    if (readResponse || mode === 'abort-on-first-byte') {
      socket.on('data', (chunk) => {
        state.received += chunk.length;
        if (readResponse) {
          state.response += chunk.toString('latin1');
        }
        if (mode === 'abort-on-first-byte') {
          socket.destroy();
        }
      });
    }
    socket.on('connect', async () => {
      socket.write(head);
      if (body) {
        socket.write(body);
      }
      if (after) {
        await sleep(after);
      }
      if (mode === 'fin') {
        socket.end();
      } else if (mode === 'rst') {
        socket.resetAndDestroy();
      } else if (mode === 'destroy' || mode === 'abort-on-first-byte') {
        socket.destroy();
      }
      resolve({ socket, state });
    });
  });
}

export const HEAD_KA = (method = 'POST', extra = '') =>
  `${method} / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n${extra}\r\n`;
