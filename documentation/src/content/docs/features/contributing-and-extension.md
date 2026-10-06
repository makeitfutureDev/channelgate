---
title: Contributing and extension
description: Contribute on beta and extend engines or chat platforms through their contracts.
---

ChannelGate accepts focused fixes, documentation, tests, and contract-based engine/platform extensions. Review is especially careful where a change affects authorization, secret handling, or confinement.

## Contributor workflow

Use your own fork, an isolated worktree, and a branch based on current upstream **beta**. Open a pull request targeting beta with validation evidence. **main** is the stable update branch; development integration is not permission to promote a stable release.

Sign off every commit with `git commit -s`. The sign-off records acceptance of the Contributor License Agreement. Read the repository's `CONTRIBUTING.md`, `CLA.md`, and Code of Conduct before submitting.

## Run meaningful checks

```sh
npm test
npm run test:coverage
npm run check:static
npm run secret-scan
npm run check:dco -- origin/beta..HEAD
```

Security-sensitive changes also need the security coverage gate. Keep `FEATURES.md`, `TEST-PLAN.md`, and applicable public guides aligned with actual behavior. Live engine/platform acceptance is distinct from a local unit-test pass; report blocked live cases explicitly.

## Extend the kernel

An engine implements a runner and validated manifest/contract, including session identity, supported network modes, authentication health, settings, and interruption. A chat surface implements its adapter/connector and capability description. Extend registries rather than spreading engine/platform-specific conditionals through the orchestrator.

An experimental or proof adapter must state its restrictions; adding it to a registry does not establish production parity. Microsoft Teams and Google Chat remain Beta. OpenCode is a restricted proof adapter.

## Licensing boundary

The proprietary source-visible licensing plane under `src/ee/` has separate terms. Discuss changes to license enforcement or tiers with maintainers before writing them. Do not remove admission or verification checks to make an extension work.

## Related guides

- [Engine capabilities reference](/docs/engines)
- [Platforms reference](/docs/platforms)
- [Compatibility](/docs/compatibility)
