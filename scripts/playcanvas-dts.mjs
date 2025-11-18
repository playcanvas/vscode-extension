import fs from 'fs';

await fs.promises.mkdir('plugin/out', { recursive: true });
await fs.promises.copyFile('node_modules/playcanvas/build/playcanvas.d.ts', 'plugin/out/playcanvas.d.ts');
