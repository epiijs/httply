import { defineConfig } from 'vitest/config';

// X9 组：结论不改变 httply 行为定义与实现的留档用例，不进每轮全量
// 运行时机见 design-node-test.md「X9 行为留档」一节
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['x9-*.test.js'],
    fileParallelism: false,
    testTimeout: 25000,
    hookTimeout: 25000
  }
});
