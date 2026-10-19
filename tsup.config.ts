import { defineConfig } from 'tsup';

/**
 * tsup 构建配置
 * - 同时输出 CJS（.cjs）和 ESM（.mjs）产物
 * - 生成 .d.ts 类型声明文件
 * - 代码压缩，但保留类名 / 函数名：错误类名是调用方排查问题的第一线索
 *   （错误消息里只写类型、不写表名，类名被压成单字母后日志将无法阅读）
 * - 保留 node: 协议前缀（node:sqlite 只能通过 node: 协议访问）
 */
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    keepNames: true,
    clean: true,
    target: 'node20',
    sourcemap: false,
    removeNodeProtocol: false,
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.mjs' })
});
