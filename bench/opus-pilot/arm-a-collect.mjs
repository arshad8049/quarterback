#!/usr/bin/env node
// Arm A: turn ALREADY-SANITIZED records (qualification-*.json, trial-*.json, grade-*.json, the kan117 results.json) into
// one-line public GitHub annotations (::notice::), so results can be read without an artifact download.
// Only allowlisted scalar fields are printed; the stage-B scan runs again on every line before it is printed.
//   node bench/opus-pilot/arm-a-collect.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';
import { scan } from '../public/kan117/stage-b-sanitize.mjs';

const dir = process.argv[2];
const files = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.json'));
const lines = [];
for (const f of files.sort()) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (j.schema === 'qb-arm-a-qualification/1') {
    const s = j.setup || {}; const ce = s.coding_env || {}; const r = ce.results || {}; const c = j.calibration || {};
    const runs = (c.runs || []).map((x) => `${x.label}${x.rep}:${x.expectation_met ? 'ok' : 'FAIL'}`).join(',');
    lines.push(`QUAL ${j.task} qualified=${j.qualified} failure=${j.failure ? `${j.failure.where}:${j.failure.why}` : 'none'} deps=${ce.deps ? ce.deps.status : '-'} test_exit=${ce.test_exit} secs=${ce.test_seconds} tap=${r.tap_ok}/${r.tap_not_ok} karma=${r.karma_pass}/${r.karma_fail} browser=${r.karma_browser_started} no_browser_signal=${ce.signals ? ce.signals.missing_browser : '-'} stdin_ok=${s.agent_input && s.agent_input.stdin_matches} ws_commits=${s.agent_input && s.agent_input.workspace_commits} briefing=${s.agent_input && s.agent_input.briefing_sha256} calib_gates=${c.gates_passed} runs=${runs} images=${(ce.distinct_images || []).join(',')}`);
  } else if (j.schema === 'qb-kan117-handoff-results/1') {
    const im = j.image_provenance.images;
    lines.push(`IMAGES agent=${im.agent.id} tools=${im.tools.id} proxy=${im.proxy.id} provenance_commit=${j.image_provenance.qb_commit} load_ok=${j.image_load && j.image_load.ok}`);
    const q = j.qb || {}; const runs = q.runs || {}; const pr = q.agent_input_probe || {};
    lines.push(`HANDOFF qb_commit=${q.qb_commit} probe_briefing_matches=${pr.briefing_matches_bundle} probe_commits=${pr.commits} probe_remotes=${pr.remotes} runs=${Object.entries(runs).map(([k, v]) => `${k}:${v && v.status}/${v && v.verification ? (v.verification.verdict || v.verification.reason) : '-'}`).join(',')} candidates=${Object.entries(q.candidates || {}).map(([k, c]) => `${k}:${c.gradable ? 'gradable' : c.not_gradable_reason}:${c.bytes}B`).join(',')} grades=${Object.entries(j.grades || {}).map(([k, g]) => `${k}:${g && g.run ? `${g.run.outcome}/${g.run.grade ? g.run.grade.official : '-'}` : 'none'}`).join(',')} not_graded=${Object.entries(j.not_graded || {}).filter(([, v]) => v).map(([k, v]) => `${k}:${v.reason}`).join(',')} cleanup=${JSON.stringify(q.cleanup)} built_from_base=${Object.values(im).map((x) => x.built_from_base).join(',')} base_digests=${Object.values(im).map((x) => x.base_digest).join(',')}`);
  } else if (j.schema === 'qb-arm-a-trial/1') {
    lines.push(`TRIAL ${j.task || 'smoke'} mode=${j.mode} dry_run=${j.dry_run} primary=${j.primary} flags=${(j.flags || []).join('+')} coding_ms=${j.coding_ms} served=${j.model && JSON.stringify(j.model.served)} api_key_source=${j.billing_route && j.billing_route.api_key_source} overage=${j.billing_route && JSON.stringify(j.billing_route.is_using_overage ?? j.billing_route.overage)} patch_bytes=${j.candidate.bytes} patch_sha256=${j.candidate.sha256} gradable=${j.candidate.gradable} grade_now=${j.grade_now} stop_batch=${j.stop_batch} overlap=${j.candidate.hidden_test_patch_overlap_lines} reasons=${(j.reasons || []).slice(0, 3).join(' | ').slice(0, 300)}`);
  } else if (j.schema === 'qb-arm-a-grade/1') {
    const g = j.grade.run || {}; const gr = g.grade || {};
    lines.push(`GRADE ${j.task} outcome=${j.outcome} official=${gr.official} evidence_valid=${gr.evidence_valid} f2p=${JSON.stringify(gr.fail_to_pass)} p2p=${JSON.stringify(gr.pass_to_pass)} candidate=${j.candidate_sha256} dry_run=${j.dry_run}`);
  }
}
for (const l of lines) {
  if (scan(l, []).length) { console.error('refused a line'); process.exit(1); }
  console.log(`::notice title=arm-a::${l.replace(/[\r\n%]/g, ' ')}`);
}
