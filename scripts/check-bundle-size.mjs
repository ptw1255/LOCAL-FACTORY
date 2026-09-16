import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const dist = path.resolve('dist/assets');
const budgets = new Map([
  ['.js', 650 * 1024],
  ['.css', 120 * 1024],
]);

const entries = await readdir(dist);
const totals = new Map();
for (const entry of entries) {
  const extension = path.extname(entry);
  const budget = budgets.get(extension);
  if (budget === undefined) continue;
  const bytes = (await stat(path.join(dist, entry))).size;
  totals.set(extension, (totals.get(extension) ?? 0) + bytes);
  if (bytes > budget) throw new Error(`${entry} is ${bytes} bytes, above the ${budget}-byte ${extension} asset budget.`);
}

for (const [extension, budget] of budgets) {
  const bytes = totals.get(extension) ?? 0;
  if (bytes > budget) throw new Error(`${extension} assets total ${bytes} bytes, above the ${budget}-byte budget.`);
  console.log(`${extension} assets: ${bytes} / ${budget} bytes`);
}
