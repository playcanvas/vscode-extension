import fs from 'fs';

await fs.promises.mkdir('out', { recursive: true });
await fs.promises.copyFile('node_modules/playcanvas/build/playcanvas.d.ts', 'out/playcanvas.d.ts');
