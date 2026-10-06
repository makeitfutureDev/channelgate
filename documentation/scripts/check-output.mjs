import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { guides } from './catalog.mjs';
import { handbookSlugs } from '../src/data/handbook.mjs';
import { checkFunctionalityCoverage } from './check-functionality.mjs';

await checkFunctionalityCoverage();

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
export const pages = ['', 'getting-started', ...handbookSlugs, ...guides.map((guide) => guide.slug)];
const htmlByPath = new Map();
for (const slug of pages) {
  const route = `/docs${slug ? `/${slug}` : ''}`;
  const html = await readFile(resolve(dist, slug, 'index.html'), 'utf8');
  assert.ok(html.includes(`href="https://channelgate.dev${route}"`), `Missing canonical: ${route}`);
  assert.ok(html.includes('starlight'), `Missing Starlight layout: ${route}`);
  assert.ok(html.includes('aria-label="Main"'), `Missing persistent sidebar: ${route}`);
  assert.equal([...html.matchAll(/<h1(?:\s|>)/g)].length, 1, `Expected one page heading: ${route}`);
  htmlByPath.set(route, html);
}
let internalLinks = 0;
for (const [route, html] of htmlByPath) {
  for (const [, href] of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
    if (!href.startsWith('/docs') && !href.startsWith('#')) continue;
    const url = new URL(href.replaceAll('&amp;', '&'), `https://channelgate.dev${route}`);
    const linked = url.pathname.replace(/\/$/, '');
    const target = htmlByPath.get(linked);
    assert.ok(target, `${route} links to missing docs route ${href}`);
    if (url.hash) {
      const anchor = decodeURIComponent(url.hash.slice(1));
      assert.ok(target.includes(`id="${anchor}"`), `${route} links to missing heading ${href}`);
    }
    internalLinks++;
  }
}
// Search must ship its actual static index, not just the search button.
const searchDirectory = resolve(dist, 'pagefind');
assert.ok((await readdir(searchDirectory)).some((name) => name.endsWith('.pf_meta')), 'Missing Pagefind search metadata');
assert.ok((await stat(resolve(dist, '_astro'))).isDirectory(), 'Missing bundled assets');
console.log(`Verified ${pages.length} Starlight pages and ${internalLinks} internal links, with the search index.`);
