import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = process.argv.indexOf('--output');
if (flag < 0 || !process.argv[flag + 1]) throw new Error('Usage: npm run export -- --output /path/to/website-output');
const destination = resolve(process.argv[flag + 1]);
if (!(await stat(destination)).isDirectory()) throw new Error('The existing website output directory is required.');
execFileSync(process.execPath, [resolve(docsRoot, 'scripts/check-output.mjs')], { stdio: 'inherit' });

// Validate the root sitemap before changing the site. Replace its docs entries as one set,
// so old routes and alternate trailing-slash spellings cannot survive another export.
const sitemapPath = resolve(destination, 'sitemap.xml');
let existing;
try { existing = await readFile(sitemapPath, 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
let merged;
if (existing) {
  if (!existing.includes('</urlset>')) throw new Error('The existing sitemap must be a URL set. Merge the docs sitemap into the index separately.');
  const docsSitemap = await readFile(resolve(docsRoot, 'dist/sitemap-0.xml'), 'utf8');
  const rows = [...docsSitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([row]) => row.replace(/(https:\/\/channelgate\.dev\/docs[^<]*?)\/(?=<\/loc>)/g, '$1'));
  const withoutDocs = existing.replace(/<url>[\s\S]*?<\/url>\s*/g, (row) => {
    const location = row.match(/<loc>(.*?)<\/loc>/)?.[1];
    return /^https:\/\/channelgate\.dev\/docs(?:\/|$)/.test(location || '') ? '' : row;
  });
  merged = withoutDocs.replace('</urlset>', `${rows.join('\n')}\n</urlset>`);
}

// Copy only the docs subtree and the root entry point used by cleanUrls deployments.
const docsDestination = resolve(destination, 'docs');
await mkdir(docsDestination, { recursive: true });
await cp(resolve(docsRoot, 'dist'), docsDestination, { recursive: true });
await cp(resolve(docsRoot, 'dist/index.html'), resolve(destination, 'docs.html'));
if (merged) await writeFile(sitemapPath, merged);
console.log('Added the docs HTML, assets, search index, and sitemap entries to the existing website output.');
