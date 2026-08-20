import { defineConfig } from 'vitest/config'

export default defineConfig({
  server: {
    sourcemapIgnoreList: () => true,
  },
  test: {
    include: ['tests/**/*.{spec,test}.{ts,tsx}'],
    // dsh-client-runtime 的 client 模块在 import 时引用 window（浏览器 bundle），
    // 纯逻辑测试需要 DOM 环境。
    environment: 'jsdom',
    pool: 'forks',
    server: {
      deps: {
        inline: [/@deepseek-ai\//],
      },
    },
  },
})
