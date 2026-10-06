import { defineConfig } from 'vitest/config';

// Node 行为套件：只收集本目录用例，与仓根 vitest.config.ts（门禁 test/）互不引用
// 用例大量依赖事件时序，禁用文件并行防止 CI 抖动（方案「用例要求」的有限时间依赖独占进程）
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['x[1-8]-*.test.js'],
    fileParallelism: false,
    testTimeout: 25000,
    hookTimeout: 25000
  }
});
