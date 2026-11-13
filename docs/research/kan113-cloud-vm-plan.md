# KAN-113: run the pilot on a cloud VM (AWS or Azure) instead of the owner's Mac. PROPOSAL, nothing provisioned

**Why:** the owner doesn't want to strain the Mac. Also, the Mac's Docker VM fails QB's memory admission (needs 11.13 GiB available, has 6.52), and macOS admission silently skips its memory check.

**Verdict:** a valid approach, and it removes three existing problems at once (§2). It needs an owner billing decision and an account; nothing is created without that.

## 1. What the VM must provide
| Need | Why | Value |
|---|---|---|
| Linux **x86_64** | the SWE-bench task images (e.g. `sweb.eval.x86_64.immutable-js…`) are x86_64. KAN-110 found arm64 problems on the Mac (`microtime` has no linux-arm64 prebuild) | Ubuntu 24.04 LTS, amd64 |
| Memory | QB admission: per-run peak 9.13 GiB + 2 GiB reserve = **11.13 GiB available** | **32 GiB** comfortable; 16 GiB is borderline (about 14 GiB available after the OS and Docker) |
| CPU | Jest + builds + the agent; one trial at a time | 8 vCPU (4 is workable, but slower) |
| Disk | images (pilot agent, tools, task images, about 1–2 GB each) + Docker cache | 100 GB SSD |
| Docker Engine | QB's sandbox | the current Docker CE |
| Interactive SSH (TTY) | the owner's per-attempt sign-in | Claude Code's login prints a URL; the owner opens it in their **own browser** and pastes the code back into the SSH terminal (the same flow QB documents in `lib/sandbox/cli.js`) |

**Candidate sizes, to check against current price pages before choosing:**
- **AWS:** `m7i.2xlarge` (8 vCPU / 32 GiB), or `m7i.xlarge` (4 / 16, borderline).
- **Azure:** `Standard_D8s_v5` (8 vCPU / 32 GiB), or `D4s_v5` (4 / 16, borderline).

Both are general-purpose x86 instances with on-demand billing per second or minute. **Usage estimate:** 12 trials × (≤ 30 min coding + setup/grading) plus image builds and smokes come to roughly **15–25 VM-hours**. Stop or deallocate the VM between sessions, so you pay only for storage while it's idle. The owner checks the actual prices; I've quoted none as fact.

## 2. What it fixes
1. **The memory admission blocker**, without touching the Mac. On Linux, QB's `admit()` reads the host's real `/proc/meminfo`, so the macOS check gap doesn't apply. That gap still gets its own fix.
2. **Architecture:** native x86_64 for both the task images and the agent image. The pilot image is rebuilt there, and its new Id is recorded per trial.
3. **The credential-wall experiments** can be re-run on a real Linux kernel. Note that Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor; the Claude Code sandbox docs describe the bubblewrap profile for that. Whether bubblewrap's normal mode starts inside QB's container there is re-tested with dummy state, and the weaker nested mode is used only if it must be.

## 3. What does NOT change
- The same frozen config (KAN-112 10583/10586): Claude Code 2.1.322, `claude-opus-5-5`, 1,800 s shared budget, A=1 / E=3 attempts, the same args and permissions.
- The owner signs in themselves for every attempt, inside that attempt's container. The credential stays in the container's tmpfs and is destroyed with it. **Nothing about the credential ever reaches the VM's disk, QB or the Mac.**
- No model calls during setup. Pilot runs stay blocked until each smoke is separately approved.

## 4. Security of the VM itself
- **SSH:** key only, from the owner's IP (the security group / NSG allows port 22 from that address only; no other inbound ports).
- **Owner-only:** a single-owner VM in the owner's cloud account. No credentials for the cloud provider live on the VM beyond what it needs to run; no QB secrets.
- **Encryption:** the disk is encrypted (the provider default).
- **Network:** the VM needs outbound access to Docker Hub, npm, PyPI/GitHub (image builds) and Anthropic. The containers' own egress stays QB-controlled (`--network none` + proxy).
- **Records:** each trial records the instance type, region, kernel, Docker version and image Ids.
- **Teardown:** destroy the VM after the pilot, or keep it stopped. Evidence (sanitized artifacts) is copied off first.

## 5. Not suitable
- **GitHub Actions runners** (used for KAN-111 grading): no interactive TTY, so our *current interactive design* can't run there unattended. **Corrected (10595/10596):** a different documented route exists (the official GitHub integration with `claude setup-token`), and it needs review; see `kan113-auth-route-comparison.md`. **Superseded by 10596:** host qualification now runs on the free GitHub runner first, and AWS/Azure is a fallback only.
- **The owner's Mac:** the owner asked to avoid the strain, and it fails admission.

## 6. Steps (each billable step needs the owner's go-ahead)
1. **The owner picks** AWS or Azure, the account and region, and the size (32 GiB recommended).
2. **The owner creates the VM.** I can produce exact CLI commands or a click-through checklist; I won't create cloud resources myself.
3. **Setup over SSH:**
   - Docker, Node 20 and git; clone the branch;
   - `npm test`;
   - rebuild the images (records the new Ids);
   - run QB admission (expect `ok`);
   - the no-model full-pipeline dry run;
   - re-run the dummy credential-wall experiments.
4. **Post the evidence** on KAN-113, then the separately approved smokes (arm B, then arm A).
