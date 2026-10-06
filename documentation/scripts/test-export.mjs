import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(resolve(tmpdir(), 'channelgate-docs-export-'));
const run = () => execFileSync(process.execPath, [resolve(root, 'scripts/export-site.mjs'), '--output', fixture], { stdio: 'pipe' });
try {
  await mkdir(resolve(fixture, 'blog'));
  const originals = {
    'index.html': '<h1>Current website</h1>',
    'blog/new-article.html': '<h1>Latest blog article</h1>',
    'blog/rss.xml': '<rss>Latest feed</rss>',
    'vercel.json': JSON.stringify({ rewrites: [{ source: '/v1/license/verify', destination: 'https://example.com/license' }] }),
  };
  for (const [path, bytes] of Object.entries(originals)) await writeFile(resolve(fixture, path), bytes);
  await writeFile(resolve(fixture, 'docs.html'), '<h1>Old link hub</h1>');
  await writeFile(resolve(fixture, 'sitemap.xml'), '<urlset><url><loc>https://channelgate.dev/blog/new-article</loc></url><url><loc>https://channelgate.dev/docs</loc></url><url><loc>https://channelgate.dev/docs/</loc></url><url><loc>https://channelgate.dev/docs/removed</loc></url></urlset>');
  run();
  for (const [path, bytes] of Object.entries(originals)) assert.equal(await readFile(resolve(fixture, path), 'utf8'), bytes);
  assert.match(await readFile(resolve(fixture, 'docs.html'), 'utf8'), /starlight/);
  assert.match(await readFile(resolve(fixture, 'docs/installation/index.html'), 'utf8'), /Install ChannelGate/);
  const sitemap = await readFile(resolve(fixture, 'sitemap.xml'), 'utf8');
  const locations = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(([, location]) => location);
  assert.equal(locations.length, 16);
  assert.equal(new Set(locations).size, locations.length);
  assert.ok(locations.includes('https://channelgate.dev/docs'));
  assert.ok(!locations.includes('https://channelgate.dev/docs/removed'));
  run();
  assert.equal(await readFile(resolve(fixture, 'sitemap.xml'), 'utf8'), sitemap, 'Export must be idempotent');
  // Unsupported root sitemaps must fail before the docs entry point is touched.
  await writeFile(resolve(fixture, 'sitemap.xml'), '<sitemapindex></sitemapindex>');
  await writeFile(resolve(fixture, 'docs.html'), 'original');
  assert.throws(run);
  assert.equal(await readFile(resolve(fixture, 'docs.html'), 'utf8'), 'original');
  // Literal Markdown syntax stays literal in the rendered guide source.
  const changelog = await readFile(resolve(root, 'src/content/docs/generated/changelog.md'), 'utf8');
  assert.ok(changelog.includes('`![alt](path.png)`'));
  console.log('Verified export preserves website, blog, API routes; merges docs sitemap once; validates before writes; preserves literal Markdown.');
} finally {
  await rm(fixture, { recursive: true, force: true });
}
