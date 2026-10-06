---
title: 开发指南
description: 环境工具、编码规范、文档写作、依赖约定与验证方式
last_updated: 2026-10-06
---

# 开发指南

## 环境工具

- Node.js ≥ 24，Node 20 已 EOL
- 包管理：npm；默认 registry 慢时可用 `https://registry.npmmirror.com`
- 取外部资料：WebFetch 不可用时改用本地 `curl -sL`，优先抓文档源而非渲染页（如 `raw.githubusercontent.com/nodejs/node/main/doc/api/*.md`）

## 编码规范

- TypeScript 保持 strict
- `types: ["node"]` 不可省：去掉后 IDE 报 `ts(2591)`，而 `tsc` 与 CI 都不报
- Node 内置模块导入必须带 `node:` 前缀：明确取内置，不受同名缓存或用户空间包干扰
- 模块级全局变量必须 `const`，不用 `let`
- 模块级函数一律 `function` 声明，不写 `const fn = () => {}`
- 注释不以标点收尾
- `test/` 用例以纯 JS 编写，只走公开 API

## 文档写作

- 使用专业的单一术语，如无必要，不新造概念
- 正向线性叙事，先提后论，不为了叙事而证明，不为了证明而反驳
- 精简紧凑，但是不为了短省字，文段要按语义适当换行

## 依赖约定

- 零运行时依赖；devDependencies 用浮动版本
- 只允许 import Node.js 内置模块，新增依赖先更新设计文档
- 依赖变动后执行一次 `npm audit`，处理有结论的高危项

## 验证方式

- `npm run lint` 必须零 error，配置见 `eslint.config.mjs`（`src/` 之外一律 ignore）
- 提交前必须执行 `npm test`，用例全部通过，且语句覆盖率 > 90%、分支覆盖率 > 80%
- 如需额外验证 Node 自身行为，按 `docs/design-node-test.md` 执行
- 如果测试未通过，需要修改历史实现，就要重做 Node 行为验证测试

## 构建发布

- 保护 ESM 构建；`moduleResolution: NodeNext` 强制编译期检查 import 要有 `.js` 后缀
- 发布清单走 `files: ["build"]` 白名单而非 `.npmignore`，范围一眼可见
