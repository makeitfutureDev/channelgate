import test from 'node:test';
import assert from 'node:assert/strict';
import { zip, documentXml } from './fixtures/docx.js';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { docxText, documentXmlText, DOCX_MAX_XML_BYTES } = await import('../src/util/docx-text.js');

test('docx text keeps paragraphs, tabs, breaks and decoded entities and drops markup', () => {
  const xml = '<w:body><w:p><w:r><w:t>Read &amp; follow</w:t><w:tab/><w:t>&lt;first&gt; &#8211; &#x2713;</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>a</w:t><w:br/><w:t>b</w:t></w:r></w:p></w:body>';
  assert.equal(documentXmlText(xml), 'Read & follow\t<first> – ✓\ncell\na\nb');
  const pkg = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': documentXml(['Readme FIRST', 'Second']) });
  assert.equal(docxText(pkg), 'Readme FIRST\nSecond');
  assert.equal(docxText(zip({ 'word/document.xml': documentXml(['Stored']) }, { method: 0 })), 'Stored');
});

test('docx text refuses non-documents, encrypted entries and oversized bodies without inflating them', () => {
  assert.throws(() => docxText(Buffer.from('plain text, not a zip')), /Not a ZIP/);
  assert.throws(() => docxText(zip({ 'other.xml': '<x/>' })), /No document body/);
  assert.throws(() => docxText(zip({ 'word/document.xml': documentXml(['x']) }, { flags: 1 })), /Encrypted/);
  assert.throws(() => docxText(zip({ 'word/document.xml': documentXml(['x']) }, { declaredSize: DOCX_MAX_XML_BYTES + 1 })), /too large/);
  // A bomb that lies about its size is still capped while inflating.
  assert.throws(() => docxText(zip({ 'word/document.xml': 'A'.repeat(DOCX_MAX_XML_BYTES + 1024) }, { declaredSize: 10 })));
});
