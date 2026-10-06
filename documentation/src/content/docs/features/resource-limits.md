---
title: Resource limits
description: Set container capacity and run concurrency, and distinguish quiet reports from stalled turns.
---

Resource controls keep a burst of agent work from overwhelming the host. Container limits and engine-run concurrency are separate controls.

## Container settings

Administrators set these in **Settings → Access & security → Container runtime**:

| Control | Default | Accepted range or behavior |
| --- | --- | --- |
| Idle stop | 10 minutes | 1–1,440 minutes |
| Max running containers | 8 | 1–500 |
| Process limit | 1,024 | 64–65,536 |
| Memory limit | Blank | No explicit container memory limit; e.g. `2g` |
| CPU limit | Blank | No explicit container CPU limit; e.g. `1.5` |

These govern container creation. Existing busy containers can defer adoption until recreation is safe.

## Engine concurrency

Operator environment setting `MAX_CONCURRENT_RUNS` defaults to **8**. Excess turns queue instead of spawning indefinitely. `RESERVED_INTERACTIVE_RUNS` defaults to **2**, limiting background-origin work so an unlimited backlog cannot take every ordinary interactive slot. These are daemon environment settings, not per-conversation model controls.

Container count does not equal engine count: several threads can work in the same conversation container.

## Quiet and stalled turns

`COMMAND_TIMEOUT` defaults to `10m` and controls the quiet-report window. It is not a blanket ten-minute task deadline. `CG_MAX_SILENCE` overrides the maximum no-progress silence budget; by default that is three quiet windows. Engine output/progress resets that clock; repeated retry messages alone do not.

For example, a long thinking turn can remain alive while reporting a quiet state. A lost engine process or exhausted silence budget is a different failure.

## Verify capacity

Inspect [System health](/docs/features/system-health), live sessions, queue notices, and the task's actual status after a change. A blank memory setting does not mean unlimited host memory exists. Choose limits that fit the workload and check whether the runtime can enforce them.

## Related guides

- [Runtime lifecycle](/docs/features/runtime-lifecycle)
- [Live sessions](/docs/features/live-sessions)
- [Failure diagnosis](/docs/features/failure-diagnosis)
