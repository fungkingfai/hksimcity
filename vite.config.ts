import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5273,
    strictPort: false,
  },
  preview: {
    host: '0.0.0.0',
    port: 4273,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // 304×304 大地圖：每次 generateWorld 約 1.5s，存檔讀檔會重新生成地形
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
