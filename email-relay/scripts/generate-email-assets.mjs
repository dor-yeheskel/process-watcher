import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const sourceUrl = new URL('../../media/process-watcher.svg', import.meta.url);
const outputUrl = new URL('../src/generated/processWatcherIcon.js', import.meta.url);
const declarationUrl = new URL('../src/generated/processWatcherIcon.d.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const brandedSource = source.replace('<svg ', '<svg color="#66C0F4" ');
const png = await sharp(Buffer.from(brandedSource))
	.resize(48, 48, { fit: 'contain' })
	.png({ compressionLevel: 9 })
	.toBuffer();
const generated = `// Generated from media/process-watcher.svg. Do not edit.\nexport const processWatcherIconPng = '${png.toString('base64')}';\n`;

await mkdir(fileURLToPath(new URL('.', outputUrl)), { recursive: true });
await writeFile(outputUrl, generated, 'utf8');
await writeFile(declarationUrl, 'export const processWatcherIconPng: string;\n', 'utf8');