import ts from 'typescript';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const directory = await mkdtemp(path.join(tmpdir(), 'quality-finance-tests-'));
try {
  for (const name of ['finance', 'market-data', 'valuation']) {
    const text = await readFile(new URL('../lib/' + name + '.ts', import.meta.url), 'utf8');
    const js = ts.transpileModule(text, { compilerOptions: { target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS } }).outputText;
    await writeFile(path.join(directory, name + '.js'), js);
  }
  const result = spawnSync(process.execPath, ['--test', 'tests/finance.test.cjs', 'tests/valuation.test.cjs'], {stdio:'inherit', env:{...process.env, QUALITY_TEST_BUILD:directory}});
  process.exitCode = result.status ?? 1;
} finally { await rm(directory, {recursive:true,force:true}); }
