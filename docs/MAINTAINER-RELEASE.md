# Maintainer release procedure

Use [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) for mandatory gates and
[COMPATIBILITY.md](COMPATIBILITY.md) for engine/runtime pins. Public contributors submit a PR
and evidence; maintainers own production access, private acceptance fixtures and release signing.
Keep private account aliases and test-channel identifiers in deployment-owned records.

## Candidate evidence

The release workflow accepts only the package version's exact tag on main. It checks the lockfile,
static analysis, tests, security coverage, current production dependency advisories and secrets in
candidate history. It builds the runtime image, inventories installed packages with Syft, hashes
model files, saves the exact image archive and signs GitHub artifact attestations over the output.
Verify downloaded artifacts with `sha256sum -c SHA256SUMS` and
`gh attestation verify <artifact> --repo makeitfutureDev/channelgate`.

`npm run release:artifacts` alone emits an **npm lockfile inventory** and **unsigned build metadata**.
It is not evidence of a built image or signed provenance. No local run should be presented as a
successful release workflow. Review upstream runtime licenses and model notices for the actual
candidate before distributing its image.

Generated-artifact secret scanning has a narrow reviewed-public-fixture catalog in
`scripts/reviewed-artifact-fixtures.json`. Each entry binds an exact matched value to public
upstream evidence and an identified purpose; private keys require the complete PEM fingerprint.
Repository/history scans never apply those exceptions. On a new finding, keep the gate failed
until provenance and purpose are verified; add no directory, package or pattern-wide exclusions.
Review the new image's count and digests after a toolchain update rather than carrying an
unexplained match forward. The catalog contains hashes and public evidence links, never values.

## Repository presentation

Repository maintainers can edit the About description, homepage and topics with GitHub settings
or `gh repo edit`. Keep the description factual: self-hosted Linux agent gateway, a container per
conversation, Slack, Microsoft Teams (Beta), Google Chat (Beta), Claude and Codex, source-available.
Use `https://channelgate.dev` as the homepage. No contributor needs the publisher's login.

A demonstration must show a real run in a disposable workspace with no customer data, credentials,
private avatars or addresses. Link it from the README only after the asset exists and is reviewed.
A social preview can be uploaded through repository settings; keep the wordmark legible at small
sizes. Missing promotional assets are not product functionality and should not be advertised as
broken links.
