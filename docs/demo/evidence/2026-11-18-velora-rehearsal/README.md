# Velora demo rehearsal, 2026-11-18 (KAN-44): redacted evidence

**One supervised rehearsal** on the owner's Mac. It is **not** a qualification of macOS, of self-service onboarding or of the KAN-44 beta epic.

## What ran
| | |
|---|---|
| Run id | `0e9eede7-be7f-41a9-a024-91e431f00f88` |
| Quarterback | `2f01d93df05d819d71d38515082a60e534156769` (main, 2026-11-12) |
| Checklist (contract file) | `docs/demo/velora-duration-contract.json`, sha256 `7fcb8c91120b5f2ba512555059b3012b275089667f75b7aafc5d14c48825c6a6`, hand-written and reviewed. **Signed off by the owner** in chat after the rehearsal, on 2026-11-18 ("I approve the demo checklist"), recorded in KAN-44 10751. The rehearsal ran before that sign-off, under the senior's technical acceptance (10748). |
| Sample | `duration-format` sample, base `14fcfe4efa8f965ae2fb08b44fe0ef2a3869cf50` (public, from `landing_page/evidence/2026-10-15-hero-run/sample-repo.bundle`) |
| Agent | Claude Code in Quarterback's Docker sandbox |
| Time | 2026-11-18 15:35:36 – 15:37:52 America/Chicago (21:35:36–21:37:52 UTC) |
| Outcome | **VERIFIED, attempt 1 of 3, 136.3 s.** L1 7 ms (reviewed contract file), L2 context 30.2 s, L3 Claude Code 105.8 s, L4 verification 67 ms |

## Environment
- **Mac:** macOS 27.2.1, 18 GB RAM, Node v20.20.2, git 2.55.0, Ollama with `deepseek-r1:7b` (context stage).
- **Docker Desktop:** engine 28.1.1, with **7.65 GiB** memory and 11 CPUs allocated (`docker info`, read 2026-11-18 after the run).
- **Sandbox images:** already present from earlier runs, so this run had no image build.

## Time outside the 136-second run (not measured precisely)
- **Setup, assisted:** the junior ran the runbook install steps in `~/qb-velora` (clone, `npm ci`, contract fetch and hash check, sample clone).
- **Owner:** started Docker Desktop and signed in.
- **Checklist preparation and review** happened beforehand, offline (KAN-44 10743, 10748).

None of this is included in the 136.3 s.

## Files
| File | What it is |
|---|---|
| `manifest.redacted.json` | The run manifest, with the home directory replaced by `~`. |
| `replay.txt` | `qb replay`: a **re-check of the stored verdict from the recorded evidence**. It does not run Claude or the tests again. |
| `candidate.diff` | The captured change, as stored by the run. |
| `velora.patch` | The exported patch (`qb patch`), sha256 `487dd8c1874fa099ca36eea81ef691219b28e256ea6ef8e2c4ff7b0ab154d816`. |
| `apply-and-target-tests.txt` | `git apply --check` on the untouched sample (clean). Then, on a throwaway copy patched by hand: `node --test test/duration.test.js` gives 4/4 pass, and the outputs are `0s | 30s | 1m 30s | 60m 0s`. |

## Which hash is which
Four different files, so four different hashes. They are not one byte-identical file under different names.

| sha256 | Artifact | Where |
|---|---|---|
| `7fcb8c91120b5f2ba512555059b3012b275089667f75b7aafc5d14c48825c6a6` | The **source checklist file** as written, reviewed and signed off | `docs/demo/velora-duration-contract.json` |
| `47584b147c11c86f7ad1a8aa7c35011cb3c2569aa971aded6376d5a060b758da` | The **normalized contract** Quarterback stored for the run (re-serialized from the source file, so its bytes differ) | `contract_hash` in `manifest.redacted.json` |
| `2eb12078a003c0e4a8aed795d6d6bf89e3407a3ae9a52ffd6f0f7e47a7a1cd37` | The **captured diff** of Claude Code's change, as stored by the run | `candidate.diff`; `patch_sha256` in the manifest |
| `487dd8c1874fa099ca36eea81ef691219b28e256ea6ef8e2c4ff7b0ab154d816` | The **exported patch** from `qb patch`: the same change with a verification header added | `velora.patch` |

**Quarterback never applied the patch.** The sample in `~/qb-velora/velora-sample` stayed unmodified.
