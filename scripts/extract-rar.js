#!/usr/bin/env node
'use strict';

/**
 * Распаковка RAR (включая RAR5) без внешних программ — официальный unrar в WebAssembly.
 *   node scripts/extract-rar.js <архив.rar> <папка>
 */

const fs = require('fs');
const { createExtractorFromFile } = require('node-unrar-js');

(async () => {
  const [archive, dest] = process.argv.slice(2);
  if (!archive || !dest) {
    console.error('Использование: node scripts/extract-rar.js <архив.rar> <папка>');
    process.exit(1);
  }
  fs.mkdirSync(dest, { recursive: true });
  const extractor = await createExtractorFromFile({ filepath: archive, targetPath: dest });
  let count = 0;
  let bytes = 0;
  for (const f of extractor.extract().files) {
    count++;
    bytes += f.fileHeader.unpSize || 0;
    if (count % 100 === 0) console.log(`  ${count} файлов, ${(bytes / 1073741824).toFixed(2)} ГБ`);
  }
  console.log(`✔ Распаковано ${count} файлов, ${(bytes / 1073741824).toFixed(2)} ГБ`);
})().catch((e) => {
  console.error('✖ Ошибка распаковки:', e.reason || '', e.message);
  process.exit(1);
});
