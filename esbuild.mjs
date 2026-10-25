import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');

/**
 * 构建前清空 dist：esbuild 的 chunk 名带内容哈希，旧 chunk 不会被覆盖而会一直堆积，
 * 最终被 vsce 一起打进 vsix（实测累积过 3 份 bridge-*.js 陈旧产物）。
 */
function cleanDist() {
  for (const dir of ['dist', 'dist/webview']) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 扩展宿主：Node/CJS，vscode 与原生驱动 external（运行时从 node_modules 解析） */
const hostConfig = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode', 'mysql2', 'pg', 'mssql', 'oracledb'],
  sourcemap: !prod,
  minify: prod,
  logLevel: 'warning',
};

/** Webview：浏览器/ESM，允许代码分割（codicons 字体、worker 等按需产物） */
const webviewConfig = {
  entryPoints: ['src/webview/main.tsx', 'src/webview/json-worker.ts'],
  outdir: 'dist/webview',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  splitting: true,
  target: 'es2020',
  sourcemap: !prod,
  minify: prod,
  loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'file' },
  define: { 'process.env.NODE_ENV': prod ? '"production"' : '"development"' },
  logLevel: 'warning',
};

async function run() {
  if (watch) {
    const ctxA = await esbuild.context(hostConfig);
    const ctxB = await esbuild.context(webviewConfig);
    await Promise.all([ctxA.watch(), ctxB.watch()]);
    console.log('[dev-toolbox] esbuild watching...');
  } else {
    cleanDist();
    await Promise.all([esbuild.build(hostConfig), esbuild.build(webviewConfig)]);
    console.log('[dev-toolbox] build done');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
