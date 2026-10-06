---
title: 任务台账
description: @epiijs/httply 工作台账，记终态与交付物清单
last_updated: 2026-10-06
---

# TODO List

@epiijs/httply 工作台账，记终态与交付物清单（做没做、被什么卡、细节在哪）。

上游指令与具体任务直接投入以下列表；无法自行解决的问题记入「需要外部协同的工作」节，由上游主动读取收集，不写入上游日志。

## 需要外部协同的工作

> 人工 Review 提出的问题高优插入本节顶部（标注「高优」）。本节是永久结构槽位，无待处理条目时不得删除。

- [ ] 修订 reference 对本组件的定位：`ref: projects/httply.md` 称本包为「轻量 HTTP 客户端/代理工具包」，背景节记「承担 HTTP 代理和转发职责」，与本仓 HTTP 消息抽象层的定位（无客户端、无转发实现）分叉；上游台账「项目族实现」节已记为消息抽象层，请统一（等待方：reference 修订 + 人工 Review）（来源：本仓 2026-09 harness 对齐时对照 reference）
- [ ] 投递 `incoming.body` 的读取时机变更 至 server：先响应后读 body 由静默 `resolve(0)` 改为 reject `HTTPLY_BODY_DROPPED`；请 server 确认路由层没有依赖「读空不报错」的写法（等待方：server 升级验证 + 人工 Review 门禁）（来源：`docs/report-node-24-v3.md` X2-5 行）
- [ ] 投递 响应后连接回收 至 server：不读 body 的分支（401/404 一类）不再需要自己带 `Connection: close` 或调 `req.destroy()`；请 server 确认访问日志与连接统计没把这类服务端主动关闭记成客户端异常，原先为规避占用加的写法可以拆掉（等待方：server 升级验证 + 人工 Review 门禁）（来源：`docs/report-node-24-v3.md` X7 组）
- [ ] 修订 harness 的文末章节约定：`ref: harness/spec-docs.md` 要求未来规划统一写进文末的「演进路线」章节，本仓该项只剩一条，与「决策不支持的能力」同族，已合并；请上游给出可否省去该章节的条件（等待方：reference 修订 + 人工 Review）（来源：本仓 2026-10 文档结构收敛）
- [ ] 发布 `1.1.0` 至 npm：版本号已写入 `package.json`，发布动作归人工；本版含 `body` 读取时机改为 reject、`CodedError` 导出与入站错误的 `code` 分类（等待方：人工）
- [ ] 改名波及面同步：本仓 `HTTPMethod` 已降为 `HttpMethod` 的弃用别名，`server/src/index.ts` re-export 与 `server/src/server/routing.ts`、`reference/projects/server.md` 仍用旧名。请 server 改用 `HttpMethod`，本仓 2.0 删除别名前完成（等待方：server 升级 + reference 修订 + 人工 Review）
- [ ] 投递 `applyToResponse` 语义变更 至 server：断连不再 pending 也不再 reject，改为 resolve `{ completed: false }`；请 server 升级依赖、闭环其台账 2026-09 Review P2 条，访问日志要区分完整与部分写入直接读 `completed`。返回类型属纯增量，忽略返回值的调用方不受影响（等待方：server 升级验证 + 人工 Review 门禁）（来源：`docs/report-node-24-v3.md` X2-4、X4、X5 组）
- [ ] 跟踪 上游 `stream.pipeline` 同步抛语义修订 至 Node：X5-1 的形态实测稳定但无文档条款，上游正按缺陷处理（#65063、#65127 至第 3 轮复核仍 open）；httply 入口处的连接状态判定与 `close` 监听两者不得收敛成单一依赖，Node 次版本升级时优先复跑 X5-1（等待方：Node 上游收敛 + 人工 Review 判据）（来源：`docs/report-node-24-v3.md` 假说清单与更新记录 3）

## 待办

> **统计**：已完成 32 / 总计 33（计全文档全部 checkbox，不含外部协同节，已完成节计入终态条目）

### 代码质量

- [ ] `spec/` 的有界等待仍有两种写法并存：`x2-termination`、`x4-write-degradation`、`x5-pipeline-errors` 各自使用 `doneRef` 加 `setTimeout`，`helpers.boundedWait` 已被其余文件采用。统一即可，机械替换，不改判据（来源：2026-10 第 2 轮验证轮）

## 已完成

> 只叙述做了什么与产出落点，不解释原因与机制；设计依据留在 `design-v1.md`，Node 事实留在报告。被后续轮次推翻的中间结论不留独立条目，只在相应行内指向当前表述。

### 1.0.0（2026-07-04）

- [x] HTTP 消息抽象层自 @epiijs/server 与 @15ms/gateway 提取为独立包并发布
- [x] `IncomingMessage`：惰性 `body`（监听 `error` / `aborted` / `data` / `end`）与惰性 `query`，getter 挂 prototype
- [x] `OutgoingMessage`：`static from()` 多态构造，`applyToResponse()` 以 `stream.pipeline` 写入，content-length 按 `Buffer.byteLength` 计算
- [x] 入站失败原因按错误实例上的 `code` 分类（`HTTPLY_BODY_ABORTED` / `HTTPLY_BODY_DROPPED`），`README.md` 与门禁按 `code` 分流，message 只作排查；带 `code` 的类型定为对外导出的 `CodedError`，出站方向不加 `code`
- [x] 零运行时依赖，vitest 单文件 25 用例
- [x] harness 建立：`AGENTS.md`、`CLAUDE.md`、`README.md`、`docs/design-v1.md`、`docs/frozen-cruorin.md`

### harness 对齐（2026-09-30）

- [x] 工具链对齐族基线：`engines` Node ≥24、`@types/node` ^24、`typescript` 显式入 devDependencies、`build` 与 `lint` 解耦、`npm test` 带 coverage、新增 `vitest.config.ts`、tsconfig 终态化（ES2024 + declarationMap + forceConsistentCasingInFileNames）、`.gitignore` 精简至 16 行并忽略 `.claude/` 与 `.qoder/`
- [x] 编码规范落地：`node:` 前缀导入（`src/message.ts`、`src/types.ts`、`test/index.test.js` 与 `README.md` 示例）
- [x] harness 补齐：`AGENTS.md` 引入工作原则、README 权威条款与 reference 交叉引用，开发指引改指向 `docs/development.md`；新增 `docs/development.md` 与本台账
- [x] 文档规范化：两份设计文档补 frontmatter，知识文档去破折号，「待查证」改为文末的「演进路线」章节并记入 `close` 不 settle 差异；本轮「附注」改名「决策不支持的能力」并并入「演进路线」，其下两个子标题取消、内容扁平为条目，门禁写法约定一节改名「测试要求」，三处指针同步

### 入站与出站语义定案（2026-09-30）

- [x] 入站读取语义定案：`body` 只承诺完整接收，未完整即 reject 且不透出 Node 的原始错误码；响应 `finish` 之后读取判为 Node 已丢弃残余并 reject（依据见报告 X1、X2 组）
- [x] 出站写入语义定案：`applyToResponse` 返回 `{ completed }`，settle 取 `finish` 与 `close` 先到者，断连按终止收敛、源流错误按故障 reject，入口释放未消费的内容流（来源：server 台账 2026-09-29 Review P2；依据见报告 X4、X5 组）
- [x] 响应完成后由 httply 回收未读完的请求，使用方不再自行关闭连接；入站读取不设超时，时限归 server 配置，httply 不持时钟（报告 X7、X8 组）
- [x] 定案不做流式请求体，`README.md` 与 `design-v1.md` 划出适用面：适合使用方读取请求体后直接处理，不适合代理转发
- [x] 评估并否决 `drain` 排空、响应后 `res.destroy()`、按声明字节数与实读字节数对账，理由记于 `design-v1.md`
- [x] 入站测试改走真实 server 回环，替身对象与 socket 桩一律删除，约定记于 `design-v1.md`「测试要求」
- [x] 命名与发布口径定案：`HttpMethod` 为正名，`HTTPMethod` 降为弃用别名，变更归 `1.1.0`
- [x] API 稳定化：确认 API 表面，补充文档与使用示例（来源：ref: harness/todo-list.md v4 设计更新 httply 组件）

### Node 行为验证体系（2026-10-04 ~ 2026-10-06）

- [x] 建成行为验证体系并跑满三轮：方案在 `docs/design-node-test.md`（7 条承诺 → 9 个行为组 → 43 条规则 → 报告），用例集 `spec/` 独立于门禁与覆盖率，报告按轮次整份重生成，现行结论见 `docs/report-node-24-v3.md`
- [x] 规则取舍标准成文：结论须被实现分支或对外承诺消费，且不能靠读文档得到；不满足者转入 X9 留档组（6 条规则、9 条用例），仍记结论、仍留用例，只是不进每轮全量
- [x] 常驻用例集 38 条覆盖 X1 至 X8 的 37 条规则，新实测两条 Node 事实：`readableDidRead` 变化晚于 `readableFlowing`（报告 X2-5）、响应发出前的三种终止形态下 socket `close` 都到达（报告 X3-3）
- [x] 防御分支与规则行逐条对齐：弃用事件退出实现判据，恒真条件与冗余的流状态检查撤销，pipeline 归因不再依赖事件先后；对外文案与语义不变
- [x] 测试职责边界重划：Node 取证退出门禁，门禁只保留 httply 自身的承诺断言（47 项），替身用例随之清理
- [x] 假说行与空洞清单按新标准复核，无风险敞口者关闭登记；`stream.pipeline` 同步抛语义的上游修订作为外部协同项挂账
- [x] 第 3 轮确认轮（2026-10-06）：实现拆分后复跑，常驻集三次全量 38/38、X9 组 9/9、门禁 47 项全过，X1 至 X8 的 37 行与第 2 轮同判、无改判；报告 `docs/report-node-24-v3.md`，时间线 `spec/node-24-v3.log`，第 2 轮报告按轮次先例删除、结论已全部迁入。用例的时间线标签自本轮起与规则编号一致，取第 2 轮 log 的证据要按 v3 报告里的映射表；防御分支对表的文件行号重新对位 `src/core/incoming-message.ts` 与 `src/core/outgoing-message.ts`；条款按 v24.14.0 原文再核一次并校正 X3-1 的引文，上游 #65063、#65127 复核仍 open
- [x] 关闭「响应已开始写出但尚未 `finish`」形态的补验：由既有 X5-1a/1b、X4-1 的时间线交叉读证，该形态下 `req` 层终止事件照常派发，零事件形态的边界确认为 `finish`，`design-v1.md` 措辞不放宽、不改写；处置记于报告更新记录 1，取证位置登记为空洞候选 H7

### 文档与用词收敛（2026-10-05 ~ 2026-10-06）

- [x] `design-v1.md` 收敛为机制与决策的单一来源：Node 行为复述改为结论与指针，机制数值移交报告；「类型设计」一节删除，内容并入两处「类设计」、「决策不支持的能力」与 `README.md`；「body 读取」与「OutgoingMessage」按实际来路重排小节，就近并入使用它们的 Node 事实，删去与源码重复的 `readRawBody` 代码块、事件时序图与不被决策消费的条目，未处理 rejection 不进门禁的理由移入「测试要求」
- [x] 全仓用词收敛：「成因」改「原因」，「本层」改 httply，「到点」改「到期」，「收尾」与「响应发出后」统一为 Node 事件名 `finish`，指向验证体系一律用「实证参见」；「终止事件不规律」「只依赖三条」「X1–X3 组常驻」这类无参照物的表述删去；注释只保留必要的 Why 并标注依据（Node 事实引规则行，参数契约引承诺项）；历史留档 `spec/node-24-v1.log` 保持原文
- [x] `design-v1.md` 复核到子句：小节引用改为按标题指代，不再写「IncomingMessage → body 读取 → …」这类层级路径；「形态」只留「终止形态」一个义项，「承诺」专指 P1–P7；「判据入档」「资格与边界」等借用词、远指与悬空代词改实指；chunked 与 `server.timeout` 统一写法，多余的「的」与空格去掉
- [x] `README.md`、第 2 轮报告与定案同步：报告 X2-5 行补记定长下两种时序均 `resolve(0)`，并纠正「四象限实测见 spec X2-5」的失准归属；P7 承诺行经人工裁定保持原文
- [x] README 拆双语：`README.md` 改中文并精简，server 计时器分工与导出类型清单删掉（细节归 `design-v1.md` 与报告）；英文另立 `README.en.md`，两份顶部互链，English 链接指向 GitHub 仓库，发布白名单 `files` 仍只含 `build`
- [x] `docs/development.md` 新增「文档写作」三条：用专业的单一术语，如无必要不新造概念；正向线性叙事，不为了叙事而证明、不为了证明而反驳；精简紧凑但不省字，文段按语义适当换行。`docs/todo-list.md`「已完成」改为终态条目制，删除中间结论与过程条目

