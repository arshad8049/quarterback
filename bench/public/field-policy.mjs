// KAN-110 normalized boundary. Every source column is assigned to exactly one store.
// ALLOWLIST: a column that is not listed here goes to quarantine (fail closed), so a new
// upstream column can never reach the agent packet by default.
//
//   agent       what both arms may see (the agent packet). Text is still leak-scanned.
//   controller  what the run controller needs to set up a task; never shown to the agent
//   vault       grading material: reference solution, test patch, test lists, grading commands
//   quarantine  everything else: hints, solution-size/shape fields, difficulty labels from
//               historical model results, answer-bearing identifiers kept only for provenance
//
// The `why` strings are the field dictionary (rendered by dictionary.mjs).

export const CLASSES = ['agent', 'controller', 'vault', 'quarantine'];

export const POLICY = {
  'swe-bench-pro-v2': {
    repo: ['controller', 'Upstream owner/name. The agent works in the checked-out repository, not from this string.'],
    instance_id: ['controller', 'Answer-bearing: embeds the fixing commit SHA. Controller only; the agent sees an opaque task ID.'],
    base_commit: ['controller', 'Commit the clean base repository is checked out at.'],
    patch: ['vault', 'Reference (gold) solution.'],
    test_patch: ['vault', 'Hidden test patch applied by the grader.'],
    problem_statement: ['agent', 'PR description written for the agent (V2: rewritten so every graded assertion traces to it).'],
    requirements: ['agent', 'Published requirements, shown to the agent by the benchmark design (paper §3.2). Given equally to both arms.'],
    interface: ['agent', 'Published new-interface description, shown to the agent by the benchmark design. Given equally to both arms.'],
    repo_language: ['controller', 'Language tag used for filtering.'],
    fail_to_pass: ['vault', 'Tests that must pass after the change (grading).'],
    pass_to_pass: ['vault', 'Regression tests that must keep passing (grading).'],
    issue_specificity: ['quarantine', 'Task tags; not needed by the agent or the grader.'],
    issue_categories: ['quarantine', 'Task tags; not needed by the agent or the grader.'],
    before_repo_set_cmd: ['vault', 'Grader setup: resets to base and applies the hidden test patch.'],
    selected_test_files_to_run: ['vault', 'Names the hidden test files the grader runs.'],
    dockerhub_tag: ['quarantine', 'Legacy v1 image tag; equals the answer-bearing instance ID. Not used for V2.'],
    docker_image: ['controller', 'V2 grader image reference (ghcr). Tag equals the instance ID, so controller only.'],
    hard: ['quarantine', 'HARD-51 label, derived from historical model failures. Must not drive selection or reach the agent.'],
    version: ['controller', 'Dataset version string (2.0.0).'],
  },
  'swe-bench-multilingual': {
    base_commit: ['controller', 'Commit the clean base repository is checked out at.'],
    created_at: ['controller', 'PR creation date. Used for provenance and deduplication only.'],
    eval_type: ['vault', 'Grading mode.'],
    image: ['controller', 'Prebuilt grader image reference (Docker Hub).'],
    instance_id: ['controller', 'Answer-bearing: owner__repo-<fixing PR number>. Controller only.'],
    log_parser: ['vault', 'Grader output parser.'],
    repo: ['controller', 'Upstream owner/name.'],
    version: ['controller', 'Harness environment version for the repository.'],
    patch: ['vault', 'Reference (gold) solution.'],
    test_patch: ['vault', 'Hidden test patch.'],
    eval_script: ['vault', 'Grading script, including the test command.'],
    problem_statement: ['agent', 'Issue title and body.'],
    hints_text: ['quarantine', 'Issue comments before the fix; may contain solution hints.'],
    FAIL_TO_PASS: ['vault', 'Tests that must pass after the change.'],
    PASS_TO_PASS: ['vault', 'Regression tests that must keep passing.'],
  },
  'swe-polybench': {
    repo: ['controller', 'Upstream owner/name.'],
    pull_number: ['quarantine', 'Answer-bearing: the fixing PR number. Kept only for provenance and deduplication.'],
    instance_id: ['controller', 'Answer-bearing: owner__repo-<fixing PR number>. Controller only.'],
    issue_numbers: ['controller', 'Linked issue numbers; used for cross-dataset deduplication only.'],
    base_commit: ['controller', 'Commit the clean base repository is checked out at.'],
    patch: ['vault', 'Reference (gold) solution.'],
    test_patch: ['vault', 'Hidden test patch.'],
    problem_statement: ['agent', 'Issue title and body.'],
    hints_text: ['quarantine', 'Issue comments before the fix; may contain solution hints.'],
    created_at: ['controller', 'PR creation date. Provenance and deduplication only.'],
    language: ['controller', 'Language tag used for filtering.'],
    Dockerfile: ['controller', 'Instance environment build file (setup).'],
    P2P: ['vault', 'Regression tests that must keep passing.'],
    F2P: ['vault', 'Tests that must pass after the change.'],
    F2F: ['vault', 'Tests failing before and after the reference fix. Not required to pass (KAN-109).'],
    test_command: ['vault', 'Grading command.'],
    task_category: ['quarantine', 'Bug Fix / Refactoring / Feature label; not needed.'],
    is_no_nodes: ['quarantine', 'Solution-shape field (retrieval metrics).'],
    is_func_only: ['quarantine', 'Solution-shape field.'],
    is_class_only: ['quarantine', 'Solution-shape field.'],
    is_mixed: ['quarantine', 'Solution-shape field.'],
    num_func_changes: ['quarantine', 'Solution-size field.'],
    num_class_changes: ['quarantine', 'Solution-size field.'],
    num_nodes: ['quarantine', 'Solution-size field.'],
    is_single_func: ['quarantine', 'Solution-shape field.'],
    is_single_class: ['quarantine', 'Solution-shape field.'],
    modified_nodes: ['quarantine', 'Names the code the reference fix changed.'],
  },
};

/** Split one source row into the four stores. Unknown columns go to quarantine. */
export function partition(source, row) {
  const policy = POLICY[source];
  if (!policy) throw new Error(`no field policy for source ${source}`);
  const out = { agent: {}, controller: {}, vault: {}, quarantine: {}, unknown: [] };
  for (const [k, v] of Object.entries(row)) {
    const p = policy[k];
    if (!p) { out.quarantine[k] = v; out.unknown.push(k); continue; }
    out[p[0]][k] = v;
  }
  return out;
}
