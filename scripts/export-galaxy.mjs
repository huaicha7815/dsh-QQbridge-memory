// 记忆银河导出器（方案二）：原版旋臂 + 核心是她 + 记忆按语义分色。
//
//   node scripts/export-galaxy.mjs
//   MEMORY_DIR=... GALAXY_OUT=... node scripts/export-galaxy.mjs
//
// 只读：只生成 tools/memory-galaxy/galaxy-data.json，不写记忆库。
// 视觉/布局来自 dsh-Memory-Galaxy（MIT, leesingx），见 tools/memory-galaxy/LICENSE。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportGalaxy } from './lib/galaxy-export.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const memoryDir = process.env.MEMORY_DIR
  ? path.resolve(process.env.MEMORY_DIR)
  : path.join(root, 'state', 'memory');
const outFile = process.env.GALAXY_OUT
  ? path.resolve(process.env.GALAXY_OUT)
  : path.join(root, 'state', 'galaxy', 'galaxy-data.json');

const result = exportGalaxy({
  memoryDir,
  outFile,
  labels: { core: '鱼鱼', coreSub: '她自己' },
});
console.log(JSON.stringify(result));
