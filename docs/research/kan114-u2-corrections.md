# KAN-114 U2: corrections accepted in 10726 / 10728

These correct statements made in the 10723 package. They change no code, workflow, limit or approval.

1. **The browser sandbox is a real boundary.** Chromium's own sandbox gives browser-internal defence in depth even when the repository's code already runs inside QB's hardened outer container. Container controls are not an equivalent replacement. The earlier claim that the sandbox "adds no boundary" is withdrawn.
2. **E1 (`--no-sandbox` for QB's Karma channel) is not approved.** The sandbox stays on. There is no privileged mode, CAP_SYS_ADMIN, seccomp=unconfined or silent fallback. The one approved build (10724) measures whether Chromium starts with its sandbox on. A missing probe result is reported as unknown, not as proof that the sandbox cannot start.
3. **D1 is disclosed, not approved.** The preact repositories' own npm-test Karma launcher disables the browser sandbox. That is not approved just because the flag comes from the repository. Any later sandbox-off exception must separately distinguish credential-free qualification from credential-bearing live trials.
4. **Image identity.** The build records a **Docker image ID**, not a registry manifest digest. `u2-image-build.yml` does not run a fresh-runner load step. Loading the image and verifying its ID must be shown in the later, separately approved qualification preflight.
5. **Approvals.** The build approval (10724) produces an image and a sandbox probe only. It does not approve task qualification, checklist authoring or live pairs. 10610 alone does not authorise the nine-task qualification workflow.
