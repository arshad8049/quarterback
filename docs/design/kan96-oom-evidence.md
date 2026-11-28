# KAN-96: OOM evidence

The decision part was approved in 10813 and is implemented in `lib/sandbox/states.js`. Since 10836 the observer is wired into the real stage path (`lib/sandbox/docker.js` runStage, every caller) as **supplementary, fallible** evidence: see "Real producer (10836)" below. It is not a reliable negative detector and not a complete fix: `unavailable` is never "no OOM", and a kill both Docker and the observer miss (row 16 of run 45509067778) still reads `completed` / `unavailable`. The integration OOM assertion is unchanged until this is reviewed.

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

## Observer experiment (option A), run 45509067778

One batch, 50 of 50, no rerun, commit `27304a9` on `kan96-oom-diagnostic`. Docker 28.0.4, cgroup v2, systemd, x86_64, image `ubuntu24 20261116.376.1`. The workload waited on one line of stdin until the observer was armed (a disclosed change to the fixture); the observer ran on the host in its own thread and did not poll.

| Case | Ran | Armed | Kill captured | Final observation | Docker reported OOM | Wrong |
|---|---|---|---|---|---|---|
| OOM | 30 | 30 | **27 (3 missed)** | 27 | 25 | 0 |
| Healthy exit | 8 | 8 | 0 | 8 | 0 | 0 |
| SIGKILL, not OOM | 6 | 6 | 0 | 5 (1 missed, so `unavailable`) | 0 | 0 |
| Observer unavailable (OOM workload) | 6 | 0 | 0 | 0 | 5 | 0 |

"Wrong" means an OOM called `none`, or a non-OOM called `oom`. Cleanup complete 50/50. Observer active time: median 0.62 ms, max 3.3 ms per iteration; arming at most 0.84 ms; at most 3 reads. These are its own event-loop times, not whole-process CPU.

* All 30 OOM runs were decided `oom`, 5 of them **only** because of the observer. In its 3 misses Docker happened to report the kill. **That is luck, not coverage:** nothing shows the two misses are independent, and a joint miss gives `completed` / `unavailable`, as in row 16.
* In all 3 misses the memory notification read 0, no second one came, and the cgroup was gone 5 to 6 ms later. In 18 captures the same first read was 0 and the empty-cgroup notification saved it. A likely cause is that the kernel limits how often it notifies for one file; **not verified**.

**Possible next step, not approved:** after a memory notification, re-read for a few milliseconds (bounded, only when notified, never standing polling). It would need its own batch.

**Not covered:** other Docker, kernel or cgroup versions, long stages, parallel runs, real agent workloads, observer loss in CI (tested only in a local VM, 2 of 2 gave no false claim), and the cost of the stdin gate for the agent stage, which already uses stdin.

## Not proposed

No change to timeouts, hardening, the fixture or verification; no CI retry; G5c and timing flakes stay separate.

## Real producer (10836)

Files: `lib/sandbox/gate.js` (start gate), `lib/sandbox/oom-observer.js` (observer thread), `lib/sandbox/docker.js` runStage, `lib/sandbox/pipeline.js` (run record). Fixtures: `test/unit/kan96-oom-producer.test.js`.

**Control channel.** On a host that can see container cgroups (Linux, cgroup v2 at /sys/fs/cgroup, local daemon) runStage creates a per-stage host directory (0755) with `gate.sh` and a FIFO `go` (0644), and bind-mounts it read-only at `/qb-gate`. The container runs `/bin/sh /qb-gate/gate.sh <the original command>`; the original entrypoint is taken from `--entrypoint` or, without one, from the image's own Entrypoint/Cmd. After `docker create`, the container's Path/Args must be exactly the gate plus the original command, or it is removed and created again ungated. The host waits (bounded) until `docker inspect` says running, arms the observer on that container id and its init pid, then writes `go`. The gate execs the command; **stdin is never read by the gate** and reaches the command byte for byte (fixture: a prompt starting with `go\n`, NUL bytes, no final newline).

**Threat model.** Task code is untrusted; the host, Docker, the image's /bin/sh and gate.sh are trusted. Before release only docker-init and the gate run in the container, so nothing untrusted can release it early. The host learns "running" from Docker, never from the container. The directory is mounted into that one container only, read-only, and removed after the stage; uid 10001 cannot write the FIFO, and writing to it after release changes nothing. Evidence is read on the host from the container's own cgroup files, which the container cannot write. The gate exits 70 without running the command unless it read exactly `go`.

**Fallbacks (all `unavailable` with the reason, the work still runs):** host unsupported (macOS / Docker Desktop: "observer unavailable on this host"), arguments not understood, gated create refused (run again with the caller's own arguments), wrong Path/Args, observer not armed (bad identity, no clean baseline), observer thread crashed or silent (2 s limits). A container that never reaches the gate ends `infra_error` and is killed. A positive read survives the observer dying later. The observer thread and gate directory are removed in `finally` on every path.

**Re-reads (frozen before batch 3):** after each memory.events notification, re-read at 1, 2, 3, 4, 6, 8, 10 ms, at most 64 per stage, stopping at a positive or a final read; nothing without a notification. Lifecycle reads: once when `docker start -a` returns, once at finish.

**Run record:** `sandbox.stages.seed`, `.agent`, `sandbox.capture`, `sandbox.deps.install`, `sandbox.verification` (and `.base`), `sandbox.checks` carry `oom_signal`, `oom_unavailable` and `oom_evidence` (gate, observer, container, cgroup path, baseline, last, final, reads, re-reads, notifications, steps, timings).
