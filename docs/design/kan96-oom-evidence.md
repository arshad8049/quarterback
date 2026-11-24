# KAN-96: OOM evidence

The decision part was approved in 10813 and is implemented in `lib/sandbox/states.js`. **Nothing produces cgroup evidence in the product yet**, so every stage reads `inspect` or `unavailable`: the observer is one approved experiment (option A), and adopting it waits for that batch's review.

## What the diagnostic showed

Run [45503431684](https://github.com/arshad8049/quarterback/actions/runs/45503431684), commit `b661872` on `kan96-oom-diagnostic`, one batch, 50 of 50 iterations, no rerun.

**Environment:** ubuntu-24.04 image `ubuntu24 20261116.133.1`, kernel `7.0.0-1014-aws`, x86_64, 4 CPUs, Docker 28.0.4, containerd v2.4.2, runc 1.5.3, cgroup v2, systemd driver.

| Observation | Iterations |
|---|---|
| Child exit 137 | 50 |
| Container's own `memory.events` read while alive, baseline `oom_kill` 0, then 1 | 50 |
| cgroup path carried the full container id and listed the sampled process | 50 |
| Docker `OOMKilled: true` and an `oom` event | 46 |
| Docker `OOMKilled: false`, no `oom` event, still false 5 s later | 4 (6, 20, 30, 38) |
| Containers, networks and volumes left behind | 0 |

**Reading:**
1. In these four runs Docker had not reported the kill within the observed five seconds. That is not proof it could never report it later. `settleOom` waits about 600 ms.
2. The container's own counter was right in all 50.
3. **The counter does not outlive the container.** In the recorded rows the last good read came 0 to 2.0 ms after the kill was first seen; then the cgroup was gone, before `docker rm`. My earlier idea (10803) of reading it before `docker rm` **does not work**.

**Limits:** one batch on one runner image; 4/50 is this sample, not customer incidence. The fixture is close to the worst case, because its main process exits at once after the kill. The sampler polled every 0.5 ms on its own thread for under a second, which is not a production design.

## Decision part (failing fixture: `test/unit/kan96-oom-evidence.test.js`)

`classifyStage(state, ctx)` takes `ctx.container` and `ctx.cgroup`, and returns `oom_signal`:

| `oom_signal` | Meaning |
|---|---|
| `inspect+cgroup`, `cgroup`, `inspect` | OOM, and which evidence said so |
| `none` | delta 0 for this container, read **after** its cgroup reported it was empty, and inspect false |
| `unavailable` | counters not read, malformed, reset, for another container, without a pre-workload baseline, or without a final observation; `oom_unavailable` says why |

OOM is: `OOMKilled` true, **or** a positive `oom_kill` delta for this exact container. Exit 137 alone is not evidence. Precedence (`infra_error`, `timeout`, `cancelled`, then `oom`) is unchanged, and the evidence is kept beside any of them. A positive delta stays even if the cgroup disappears or the observer fails later. `oom_killed` keeps meaning Docker's own flag. `unavailable` is recorded and never shown as "no OOM".

## Observation part: needs your choice

| Option | For | Against |
|---|---|---|
| **A. Host observer on its own thread, woken by change notifications on `memory.events`** | no change to the container; container-specific | **untested.** Whether the notification and read fit in a 0–2 ms window is the open question. If it misses, the result is `unavailable`, not wrong |
| B. The same, polling every 0.5 ms | 50/50 in the diagnostic | two file reads per tick for stages of up to 30 min; cost not measured |
| C. A dedicated parent cgroup per stage, read after exit | would outlive the container | 10807 rules out parent counters as proof; systemd may remove an empty slice; changes container creation |
| D. A trusted process inside the container reads it at the end | simple | runs beside untrusted code under the same uid, so it can be forged or killed |
| E. Docker `oom` events | simple | **refuted:** missing in the same four runs |

**I suggest A, with the decision part first.** It needs one more bounded, branch-only batch to measure A's capture rate before relying on it, and I have not been approved for that. On hosts where the counters cannot be read (Docker Desktop, seen here), the result stays `inspect` or `unavailable`, and this is not a resolved guarantee there.

## Not proposed

No change to timeouts, hardening, the fixture or verification; no CI retry; G5c and timing flakes stay separate.
