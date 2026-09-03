<!--
Security vulnerabilities are never fixed in a public pull request. Follow SECURITY.md instead.
-->

## Summary

<!-- What changes, and why. One change per pull request; a refactor and a behaviour change are two. -->

## Design note

<!--
The durable record for a reviewer: the problem, the option you chose, the options you rejected,
and anything a future reader would otherwise have to reconstruct from the diff. A few sentences is
usually enough. Larger designs are agreed in an issue before the code is written.
-->

## Test evidence

<!-- Paste the actual output, not "tests pass". Note anything you could not run and why. -->

```
npm run check:static   →
npm test               →
npm run secret-scan    →
```

## Checklist

- [ ] Every commit is signed off (`git commit -s`) — the trailer is CLA acceptance (`CLA.md` §7)
- [ ] Tests added or updated; a bug fix has a regression test that fails without the fix
- [ ] `TEST-PLAN.md` updated for a behaviour change; `FEATURES.md` / `CHANGELOG.md` updated for a
      user-visible one
- [ ] No secrets, tokens, license keys, customer data, or internal notes in the diff or the
      description; `npm run secret-scan` is clean
- [ ] Linux only (systemd + rootless Podman) — no macOS/launchd branches, no platform-specific
      binaries, portable Node APIs preferred over shelling out
- [ ] Confinement preserved: no engine exec'd outside a channel container, the container mounts
      and permission allowlists intact
- [ ] Secrets still never ride a listing response (`has*` / `last4` only; new secret fields added
      to the reveal allowlist)
- [ ] Documentation updated (`README.md`, `INSTALL.md`, `docs/`) where behaviour or setup changed
- [ ] Only my own files are staged — no unrelated edits swept in
