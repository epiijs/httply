import http, {
  OutgoingHttpHeaders
} from 'node:http';
import {
  pipeline, Readable
} from 'node:stream';

import type {
  AnyForOutgoingMessage,
  CodedError,
  IOutgoingMessage,
  OutgoingMessageContent
} from '../types.js';

function isReadableStream(o: unknown): o is Readable {
  return o instanceof Readable;
}

// ERR_STREAM_UNABLE_TO_PIPE 的定义即「pipe 到已关闭或已销毁的目标」，只可能来自目标侧（spec X5-1）
function isDestinationGone(error: CodedError): boolean {
  return error.code === 'ERR_STREAM_UNABLE_TO_PIPE';
}

// ERR_STREAM_PREMATURE_CLOSE 两侧都可能产生，目标流状态判不出来源（spec X5-3）
function isPrematureClose(error: CodedError): boolean {
  return error.code === 'ERR_STREAM_PREMATURE_CLOSE';
}

// 响应 finish 后，body 截断的连接无法再解析后续请求
// 主动回收，不等待 keepAliveTimeout（承诺 P5，spec X7-1、X7-3）
function reclaimUnreusableConnection(response: http.ServerResponse): void {
  // response.req 未纳入公开 API，非标准响应对象可能缺失（承诺 P6）
  const request = response.req as http.IncomingMessage | undefined;
  if (request) {
    // 判定延后一个 tick：finish 时刻 readableEnded 仍可能为 false，当场判定会误销毁本可复用的连接（spec X7-2）
    setImmediate(() => {
      if (!request.readableEnded) {
        request.destroy();
      }
    });
  }
}

export class OutgoingMessage implements IOutgoingMessage {
  readonly status: number;
  readonly headers: OutgoingHttpHeaders;
  readonly content: OutgoingMessageContent;

  constructor(init?: { status?: number; headers?: OutgoingHttpHeaders; content?: OutgoingMessageContent; }) {
    this.status = init?.status ?? 200;
    this.headers = init?.headers ?? {};
    this.content = init?.content ?? '';
  }

  /**
   * 由任一可接受的入参构造消息：
   * - `string` / `Buffer` / `Readable`：status 200，content-type 按类型取默认值
   * - 对象形态：逐项取用 status / headers / content，未给出的按默认值补全
   * - 空值：204 空响应
   */
  static from(message: AnyForOutgoingMessage): OutgoingMessage {
    if (!message) {
      return new OutgoingMessage({ status: 204, content: '' });
    }
    if (typeof message === 'string') {
      return new OutgoingMessage({
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': Buffer.byteLength(message, 'utf-8').toString()
        },
        content: message
      });
    }
    if (Buffer.isBuffer(message)) {
      return new OutgoingMessage({
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': message.length.toString()
        },
        content: message
      });
    }
    if (isReadableStream(message)) {
      return new OutgoingMessage({
        status: 200,
        headers: {
          'content-type': 'application/octet-stream'
        },
        content: message
      });
    }
    const maybeContent = message.content;
    const maybeContentIsString = typeof maybeContent === 'string' || maybeContent == null;
    return new OutgoingMessage({
      status: message.status ?? 200,
      headers: message.headers ?? {
        'content-type': maybeContentIsString ? 'text/plain; charset=utf-8' : 'application/octet-stream'
      },
      content: maybeContent ?? ''
    });
  }

  /**
   * 将消息写入响应，返回 completed 指示是否写完整
   * 连接提前终止照常 resolve false，仅响应方异常 reject 透传（承诺 P2 至 P4）
   */
  async applyToResponse(response: http.ServerResponse): Promise<{ completed: boolean; }> {
    return new Promise((resolve, reject) => {
      // 连接在写入开始前已终止：close 不会派发第二次，只监听事件会永久挂起，故先判定连接状态并释放内容流（spec X3-1）
      // destroyed 在响应正常完成后同为 true，用 writableEnded 排除本次已发送完毕的情况（spec X4-3）
      if (response.destroyed && !response.writableEnded) {
        if (isReadableStream(this.content)) {
          this.content.destroy();
        }
        resolve({ completed: false });
        return;
      }

      let sourceError: Error | null = null;

      // 完成源有四路且到达次序不固定（spec X3-5、X5-4），Promise 先到先得，后到的信号自动无效
      // completed 只以 finish 事件为判据：断连路径下 writableEnded 与 writableFinished 仍可能为 true
      const settleResolve = (completed: boolean): void => resolve({ completed });
      const settleReject = (error: Error): void => reject(error);

      response.on('finish', () => {
        reclaimUnreusableConnection(response);
        settleResolve(true);
      });
      // 真实响应上不派发 error（spec X2-4、X5-5）
      // 保留它是进程保护：无监听器的 error 事件会抛出到进程外
      response.on('error', settleReject);
      // 断连路径只有 close 会派发，且 close 可能早于 pipeline 回调，故源流错误要提前捕获
      response.on('close', () => {
        if (sourceError) {
          settleReject(sourceError);
        } else {
          settleResolve(false);
        }
      });

      response.writeHead(this.status, this.headers);
      if (isReadableStream(this.content)) {
        this.content.on('error', (error: Error) => {
          // pipeline 失败连带销毁源流，源流随之收到 PREMATURE_CLOSE，它不是源侧的业务错误（spec X5-2、X5-3）
          if (!isPrematureClose(error)) {
            sourceError = error;
          }
        });
        pipeline(this.content, response, (error: Error | null) => {
          if (!error) {
            return;
          }
          if (sourceError) {
            settleReject(sourceError);
          } else if (isDestinationGone(error) || isPrematureClose(error)) {
            // 目标侧终止：内容未能送达，但不是响应方故障
            settleResolve(false);
          } else {
            // 默认出口：其余错误一律按响应方故障上抛（承诺 P4），真实响应上无可达形态
            settleReject(error);
          }
        });
      } else if (this.content) {
        response.write(this.content);
        response.end();
      } else {
        response.end();
      }
    });
  }
}
