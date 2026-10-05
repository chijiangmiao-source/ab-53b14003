// 静态站点构建：将 web/ 与 src/engine.js 拷入 dist/，无第三方依赖
import { cp, mkdir, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await cp(resolve(root, 'web'), dist, { recursive: true });
  await cp(resolve(root, 'src', 'engine.js'), resolve(dist, 'engine.js'));
  // 构建检查：关键产物必须存在
  for (const f of ['index.html', 'app.js', 'styles.css', 'engine.js']) {
    await access(resolve(dist, f));
  }
  console.log(`[build] 页面构建完成 -> ${dist}`);
}

main().catch((err) => {
  console.error('[build] 失败:', err);
  process.exit(1);
});
