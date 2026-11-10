# KAN-111 lock evidence: run 42906422892

The six sanitized lock-phase output files, preserved byte for byte from the `kan111-lock` artifact.

- **Run:** https://github.com/arshad8049/quarterback/actions/runs/42906422892 at commit `e52e88a1ab3d9ebc8fcbd039076bdcd21a0c1766` (lock approval: KAN-111 comment 10557; reviewed PASS: comment 10559).
- **Artifact zip** (downloaded by the owner from the run page on 2026-11-10): sha256 `7e49b5184517c0869c7812e149a3e268137df63cecdbb95c3a384f9d8c023a20`, which equals the digest the reviewer computed in 10559.
- **File hashes:** all six equal the 10559 values. `workflow.grade.proposed.yml` re-checks them before installing anything.
- **Contents:** package names, versions, hashes and runner metadata only. They contain no gold patches, tests, required-test lists or vault data. `lock-sanitize.sh` passes on these files.

| File | sha256 |
|---|---|
| `requirements.lock` | `3ff9e5ec290027e4925964a8eb537af39f676a588aa81d9da2f429619e7de1ba` |
| `dists.sha256` | `0123302e17e1933d5c7e321734c47b25e0764ab4bb91b5fa1a941c74d98b2b32` |
| `archive.sha256` | `a60f0de346e0783dc6645edeb537b24b0f5d35c9d01be7a19f6b129bf5f79bff` |
| `harness-files.sha256` | `1a454284cf5fd8afef66e40a0e0d3581548c2504a938fbdfdea35c20f177705c` |
| `env.txt` | `7195c125aa09cc048505378fbede55c127dc65b7797ab8b75d7ca5cc843cfcf7` |
| `build-notes.txt` | `24b24a510d29fdac8c7215faf93238ac41453332d472e91fdec85545af6a3f5e` |
