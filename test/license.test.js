import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("package and public documentation identify the source-available license consistently", async () => {
  const [pkgText, lockText, license, readme, decision, features] = await Promise.all([
    read("package.json"),
    read("package-lock.json"),
    read("LICENSE.md"),
    read("README.md"),
    read("docs/LICENSING-DECISION.md"),
    read("FEATURES.md"),
  ]);
  const pkg = JSON.parse(pkgText);
  const lock = JSON.parse(lockText);

  assert.equal(pkg.license, "SEE LICENSE IN LICENSE.md");
  assert.equal(lock.packages[""].license, pkg.license);
  assert.match(pkg.author, /Tiberiu Socaci/);
  assert.match(license, /Makeitfuture Sustainable Use License/);
  assert.match(license, /right to use, reproduce, modify, distribute, make\s+available,/);
  assert.match(license, /internal business operations/);
  assert.match(license, /paid hosted, managed, white-label/);
  assert.match(license, /contact@makeitfuture\.com/);
  assert.match(license, /not an\s+Open Source Initiative approved/i);
  assert.match(readme, /source-available fair-code/i);
  assert.match(readme, /not OSI open-source/i);
  assert.match(decision, /Authorized owner\/approver: Tiberiu Socaci/);
  assert.match(decision, /modeled on n8n's Sustainable Use License/);
  assert.doesNotMatch(license, /competing commercial gateway/);
  for (const summary of [features]) {
    assert.match(summary, /internal business deployments may\s+be used and modified/i);
    assert.match(summary, /personal\/noncommercial use(?: and modification)? (?:is|are) (?:allowed|permitted)/i);
  }
});

test("version 1.2 names ChannelGate, adds license keys, keeps control, and has no Change Date", async () => {
  const [license, cla, faq, keys, trademark, authors, decision, readme, changelog, checklist] =
    await Promise.all([
      read("LICENSE.md"),
      read("CLA.md"),
      read("docs/LICENSING-FAQ.md"),
      read("docs/LICENSE-KEYS.md"),
      read("TRADEMARK.md"),
      read("AUTHORS.md"),
      read("docs/LICENSING-DECISION.md"),
      read("README.md"),
      read("CHANGELOG.md"),
      read("docs/RELEASE-CHECKLIST.md"),
    ]);

  // The license is versioned and says so in one place that the docs can cite.
  assert.match(license, /^# Makeitfuture Sustainable Use License\n\nVersion 1\.2$/m);
  assert.match(license, /ChannelGate \(formerly "Claude Gateway for Slack"\)/);
  assert.match(license, /ChannelGate \(the \*\*Software\*\*\)/);
  assert.match(license, /Original author: Tiberiu Socaci — see `AUTHORS\.md`/);

  // 3.1 keeps the service-work conditions, per deployment, on the customer's key.
  assert.match(license, /Dedicated deployments operated on a customer's behalf/);
  assert.match(license, /serves that one customer and its organization/);
  assert.match(license, /can take over or migrate the deployment/);
  assert.match(license, /charged for your services/);
  assert.match(license, /was issued to that customer under Section 3\.2/);
  assert.match(license, /any number of separate\s+deployments for different customers under this section without an agreement/);
  assert.match(license, /shared by or offered to more than one\s+customer/);
  assert.match(license, /\*\*Internal business operations\*\* means/);

  // 3.2 / 4.5 / 12: license keys, end-user keys only, no circumvention.
  assert.match(license, /### 3\.2 License keys and usage limits/);
  assert.match(license, /Without a key, the Software\s+serves a single conversation/);
  assert.match(license, /\(an \*\*end-user key\*\*\)/);
  assert.match(license, /may not share, pool, transfer, or resell a key/);
  assert.match(license, /acting under Section 3\.1 uses the customer's own key/);
  assert.match(license, /circumvent or disable license-key verification, usage limits, or usage reporting/);
  assert.match(license, /\*\*License key\*\* means/);
  assert.match(license, /\*\*Conversation\*\* means/);
  assert.match(license, /will not reduce the limits of an\s+enterprise key during its agreed term/);

  // The commercial agreements are named so the FAQ and sales point at the same things.
  for (const name of ["Reseller Agreement", "White-Label Agreement", "Enterprise License", "Partner Agreement"]) {
    assert.match(license, new RegExp(`\\*\\*${name}\\*\\*`));
  }
  assert.match(license, /operating such deployments does\s+not itself require any agreement/);

  // De-branding is a restriction; trademark guidance lives in its own file.
  assert.match(license, /remove, replace, or obscure the Software's names, marks, or attribution/);
  assert.match(license, /Rebranding or white-labeling\s+the Software requires a separate written agreement/);
  assert.match(license, /by `TRADEMARK\.md`/);
  assert.match(trademark, /trademarks of MAKEITFUTURE S\.R\.L\./);
  assert.match(trademark, /we install, host, and support\s+ChannelGate/);
  assert.match(trademark, /must not use the name as its own product name/);

  // Inbound contribution terms exist and point at a CLA that grants relicensing.
  assert.match(license, /## 6\. Contributions/);
  assert.match(license, /\[`CLA\.md`\]\(CLA\.md\)/);
  assert.match(cla, /^# ChannelGate Contributor License Agreement/m);
  assert.match(cla, /Version 1\.1 — effective 2026-08-25/);
  assert.match(cla, /relicense your Contribution under other terms/);
  assert.match(cla, /Signed-off-by: Your Name/);
  assert.match(cla, /Nothing here assigns copyright/);
  assert.match(cla, /No automatic relicensing of any\s+version is promised/);
  assert.match(readme, /`Signed-off-by` trailer/);
  assert.match(authors, /created by \*\*Tiberiu Socaci\*\*/);
  assert.match(authors, /intellectual-property assignment/);
  assert.match(decision, /acceptance of `CLA\.md` for all pre-CLA contributions/);

  // Control: no Change Date, no automatic relicensing, anywhere in the public texts.
  // Mentions of the removed clause are allowed only as history ("removed", "since removed",
  // "carried a delayed ... grant"); the operative wording must be gone from every public text.
  for (const [name, text] of Object.entries({ license, cla, faq, keys, readme, changelog, checklist, trademark, authors })) {
    assert.doesNotMatch(text, /fourth anniversary/, `${name} still carries the four-year clause`);
    assert.doesNotMatch(text, /additionally (?:made )?available (?:to you )?under/, `${name} still grants a delayed license`);
    assert.doesNotMatch(text, /## \d+\. Change Date/, `${name} still has a Change Date section`);
  }
  assert.doesNotMatch(license, /Apache License, Version 2\.0/);
  assert.doesNotMatch(license, /irrevocable once a version's Change Date/);
  assert.doesNotMatch(cla, /Change Date under Section 7/);
  assert.doesNotMatch(faq, /\*\*Will it become open source\?\*\* Yes/);
  assert.match(license, /## 7\. Patents/);
  assert.match(license, /Nothing in this license obliges the Licensor to publish future versions/);
  assert.match(license, /## 11\. Governing law and venue/);
  assert.match(license, /laws of Romania/);
  assert.match(license, /courts\s+of Bucharest/);
  assert.match(license, /removed the former Section 7\s+Change Date — no version is relicensed automatically/);
  assert.match(faq, /There is no automatic relicensing/);
  assert.match(readme, /no version\s+is relicensed automatically/);
  assert.match(changelog, /No version is\s+(?:> )?relicensed automatically/); // wraps inside a blockquote
  assert.match(checklist, /Counsel reviewed license \*\*v1\.2\*\*/);
  assert.match(checklist, /Word-mark clearance for \*\*ChannelGate\*\*/);

  // Tiers are documented once, consistently, with end-user keys and offline grace.
  assert.match(keys, /\| \*\*No key\*\* \| install and run \| 1 \| 500 \|/);
  assert.match(keys, /\| \*\*Free key\*\* \| .* \| unlimited \| 500 \|/);
  assert.match(keys, /\| \*\*Enterprise key\*\* \| .* \| unlimited \| unlimited \|/);
  assert.match(keys, /an end-user key/);
  assert.match(keys, /never shared, pooled, or transferred across organizations/);
  assert.match(keys, /\*\*14 days\*\*/);
  assert.match(keys, /never contains message content/);
  assert.match(readme, /500 AI messages per conversation per month/);
  assert.match(faq, /Running ChannelGate for yourself is free, within the limits of your key/);
  assert.match(faq, /An agency does the above for twenty clients\.\*\* Permitted/);
  assert.match(faq, /An agency puts its own key into every client's deployment\.\*\* §3\.2\/§4\.5/);

  // The FAQ is guidance only and must never outrank the license it explains.
  assert.match(faq, /where the two differ, `LICENSE\.md` controls/);

  // Security is not a feature tier — the same promise in the FAQ and the decision record.
  for (const doc of [faq, decision]) {
    assert.match(doc, /sandbox/i);
    assert.match(doc, /backup\/restore/);
  }
  assert.match(faq, /Security is not a feature tier/);
  assert.match(faq, /Slack, Microsoft Teams, and Google Chat are free/);
  assert.match(decision, /## Amendment: version 1\.2/);
  assert.match(decision, /end-user keys only/);
  assert.match(decision, /Authorized owner\/approver: Tiberiu Socaci\n\nRequested in #gateway-slack/);

  // Still source-available, never OSI open source — the 1.0 framing survives the amendment.
  assert.match(faq, /It is \*\*source-available\*\* \/ \*\*fair-code\*\*/);
  assert.match(faq, /Calling it\s+open source misrepresents it/);
});

test("bundled Poppins fonts retain their complete OFL notice", async () => {
  const [notice, ofl] = await Promise.all([
    read("THIRD_PARTY_NOTICES.md"),
    read("public/fonts/OFL.txt"),
  ]);
  assert.match(notice, /Poppins Project Authors/);
  assert.match(notice, /SIL Open Font License, Version 1\.1/);
  assert.match(ofl, /Copyright 2020 The Poppins Project Authors/);
  assert.match(ofl, /PERMISSION & CONDITIONS/);
  assert.match(ofl, /5\) The Font Software/);
  assert.match(ofl, /DISCLAIMER/);
});
