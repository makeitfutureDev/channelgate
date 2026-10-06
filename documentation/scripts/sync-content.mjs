import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guides } from './catalog.mjs';

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(docsRoot, '..');
const output = resolve(docsRoot, 'src/content/docs/generated');
const slugs = new Map(guides.map((guide) => [guide.source, guide.slug]));
const sourceRef = process.env.CHANNELGATE_DOCS_REF || 'beta';
const sourceBase = `https://github.com/makeitfutureDev/channelgate/blob/${encodeURIComponent(sourceRef)}/`;

function destination(raw, source) {
  const angle = raw.startsWith('<') && raw.endsWith('>');
  const link = angle ? raw.slice(1, -1) : raw;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#|\/docs(?:\/|$))/i.test(link)) return raw;
  const boundary = link.search(/[?#]/);
  const path = boundary < 0 ? link : link.slice(0, boundary);
  const suffix = boundary < 0 ? '' : link.slice(boundary);
  const relative = posix.normalize(path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(source), path));
  const slug = slugs.get(relative);
  const target = slug ? `/docs/${slug}${suffix}` : `${sourceBase}${relative}${suffix}`;
  return angle ? `<${target}>` : target;
}

function rewriteLinks(markdown, source) {
  let fence;
  return markdown.split('\n').map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      return line;
    }
    if (fence) return line;
    // Preserve inline code examples, including Markdown links shown as literal syntax.
    return line.split(/(`+[^`]*`+)/g).map((part) => part.startsWith('`') ? part : part
      .replace(/(\]\()(<[^>]+>|[^\s)]+)([^)]*\))/g, (_, start, url, end) => `${start}${destination(url, source)}${end}`)
      .replace(/^( {0,3}\[[^\]]+\]:\s*)(<[^>]+>|\S+)/, (_, start, url) => `${start}${destination(url, source)}`)
      .replace(/(href=")([^"]+)(")/g, (_, start, url, end) => `${start}${destination(url, source)}${end}`)).join('');
  }).join('\n');
}

await mkdir(output, { recursive: true });
// This directory contains only build-generated copies, never authored content.
for (const file of await readdir(output)) if (file.endsWith('.md')) await unlink(resolve(output, file));
for (const guide of guides) {
  const markdown = await readFile(resolve(repository, guide.source), 'utf8');
  const body = rewriteLinks(markdown.replace(/^# [^\n]+\n*/, ''), guide.source);
  const frontmatter = `---\ntitle: ${JSON.stringify(guide.title)}\ndescription: ${JSON.stringify(guide.description)}\nslug: ${JSON.stringify(guide.slug)}\neditUrl: ${JSON.stringify(`https://github.com/makeitfutureDev/channelgate/edit/${encodeURIComponent(sourceRef)}/${guide.source}`)}\n---\n\n`;
  await writeFile(resolve(output, `${guide.slug.replaceAll('/', '-')}.md`), frontmatter + body);
}
console.log(`Prepared ${guides.length} guides from the repository Markdown sources.`);
