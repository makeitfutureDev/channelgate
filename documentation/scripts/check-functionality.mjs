import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guides } from './catalog.mjs';
import { handbookSlugs } from '../src/data/handbook.mjs';
import { controlPages } from '../src/data/control-reference.mjs';
import { functionalityAreas } from '../src/data/functionality-coverage.mjs';

export async function checkFunctionalityCoverage() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const sourceRoot = resolve(root, 'documentation/src/content/docs');
  const slugs = new Set(['', 'getting-started', ...handbookSlugs, ...guides.map((guide) => guide.slug)]);
  assert.equal(slugs.size, 2 + handbookSlugs.length + guides.length, 'Duplicate documentation route');
  assert.deepEqual(functionalityAreas.map((area) => area.id), Array.from({ length: 45 }, (_, index) => index + 1));
  for (const area of functionalityAreas) {
    assert.ok(area.topics.length, `Missing guides for ${area.label}`);
    for (const slug of area.topics) assert.ok(slugs.has(slug), `Unmapped guide ${slug} in ${area.label}`);
  }

  const expected = new Map();
  const toolsDirectory = resolve(root, 'src/mcp/tools');
  const files = (await readdir(toolsDirectory)).filter((name) => name.endsWith('.js')).map((name) => resolve(toolsDirectory, name));
  files.push(resolve(root, 'src/web/skills-mcp.js'));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const [, name] of source.matchAll(/registerTool\(\s*["']([^"']+)["']/g)) {
      assert.ok(!expected.has(name), `Duplicate source tool ${name}`);
      expected.set(name, file);
    }
  }

  const documented = new Map();
  for (const page of controlPages) {
    const markdown = await readFile(resolve(sourceRoot, `controls/${page.slug}.md`), 'utf8');
    for (const [, name] of markdown.matchAll(/^##\s+`?([a-z][a-z0-9]*_[a-z0-9_]+)`?\s*$/gm)) {
      assert.ok(expected.has(name), `Unknown control heading ${name}`);
      assert.ok(!documented.has(name), `${name} is documented twice`);
      documented.set(name, page.slug);
    }
  }
  for (const name of expected.keys()) assert.ok(documented.has(name), `Missing control reference: ${name}`);
  const libraryCount = [...expected.keys()].filter((name) => name.startsWith('library_')).length;
  const gatewayCount = expected.size - libraryCount;
  const directory = await readFile(resolve(sourceRoot, 'controls.mdx'), 'utf8');
  assert.ok(directory.includes(`**${gatewayCount} controls**`), 'Update gateway count in control directory');
  assert.ok(directory.includes(`**${libraryCount} more**`), 'Update library count in control directory');
  console.log(`Verified ${functionalityAreas.length} functionality areas and ${gatewayCount} gateway + ${libraryCount} library controls, each documented exactly once.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkFunctionalityCoverage();
