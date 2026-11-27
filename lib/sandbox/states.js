/**
 * lib/sandbox/states.js — decide a sandbox stage's terminal state.
 *
 * Decided from `docker inspect` State plus what the control plane did to the
 * container, in a fixed precedence (agent-sandbox.md §8.4). Never from the exit
 * code alone: E2 observed OOMKilled=true with ExitCode=0, when an OOM-killed
 * child's parent exited cleanly.
 */

const STAGE_STATES = ['infra_error', 'timeout', 'cancelled', 'oom', 'execution_error', 'completed'];

/**
 * KAN-96 (10813): what the container's OWN memory.events says. `cgroup` is produced by a host-side observer of exactly
 * this container: { container, baseline, last, final } or { container, unavailable }.
 * @returns {{ positive: boolean, zero: boolean, why?: string }} zero only with a read taken after the cgroup was empty
 */
function cgroupEvidence(container, cgroup) {
  const none = (why) => ({ positive: false, zero: false, why });
  if (!cgroup) return none('no observer');
  if (!container || cgroup.container !== container) return none('the evidence is not for this container');
  const { baseline: b, last: l } = cgroup;
  const counts = Number.isSafeInteger(b) && Number.isSafeInteger(l) && b >= 0 && l >= 0;
  if (counts && b === 0 && l > b) return { positive: true, zero: false };   // kept even if the observer failed later
  if (cgroup.unavailable) return none(String(cgroup.unavailable));
  if (!counts) return none('unreadable counters');
  if (b !== 0) return none('no pre-workload baseline (a kill was already counted)');
  if (l < b) return none('the counter was reset');
  return cgroup.final === true ? { positive: false, zero: true } : none('no final observation after the workload ended');
}

/**
 * @param {object|null} state - parsed `docker inspect` .State (null if unavailable)
 * @param {object} ctx - { infraError?: string, killedBy?: 'deadline'|'cancel'|null, container?: string, cgroup?: object }
 * @returns {{ state, reason, exit_code, oom_killed, oom_signal, oom_unavailable? }} oom_killed is Docker's own flag;
 *   oom_signal: inspect+cgroup | cgroup | inspect | none | unavailable (kept beside any outcome)
 */
function classifyStage(state, ctx = {}) {
  const exit_code = state && Number.isInteger(state.ExitCode) ? state.ExitCode : null;
  const oom_killed = Boolean(state && state.OOMKilled);
  const cg = cgroupEvidence(ctx.container, ctx.cgroup);
  const oom_signal = oom_killed && cg.positive ? 'inspect+cgroup' : cg.positive ? 'cgroup' : oom_killed ? 'inspect' : cg.zero ? 'none' : 'unavailable';
  const evidence = { oom_signal, ...(cg.why ? { oom_unavailable: cg.why } : {}) };
  const out = (s, reason) => ({ state: s, reason, exit_code, oom_killed, ...evidence });

  if (ctx.infraError) return out('infra_error', ctx.infraError);
  if (!state) return out('infra_error', 'container state unavailable');
  if (state.Running || state.Status !== 'exited') return out('infra_error', `container not exited (status ${state.Status})`);
  if (ctx.killedBy === 'deadline') return out('timeout', 'stage deadline');
  if (ctx.killedBy === 'cancel') return out('cancelled', 'cancelled by user');
  if (oom_killed) return out('oom', exit_code === 0 ? 'OOMKilled (main process exited 0)' : 'OOMKilled');
  if (cg.positive) return out('oom', 'oom_kill counted in the container\'s own cgroup (Docker did not report it)');
  if (exit_code !== 0) return out('execution_error', `exit ${exit_code}`);
  return out('completed', 'exit 0');
}

/**
 * KAN-96 10848: is a stage's OOM EVIDENCED? Docker's own OOMKilled=true, or validated positive evidence from the
 * container `containerId` (which the caller gets from Docker, not from the stage result): the observer was armed on
 * exactly that container, its cgroup path is named after it, the pre-workload baseline was 0 and a later oom_kill
 * read was larger. An exit code, `unavailable`, a state of "oom" or knowing a fixture injects an OOM never is.
 */
function oomEvidenced(stage, containerId) {
  if (!stage || typeof stage !== 'object') return false;
  if (stage.oom_killed === true) return true;
  const e = stage.oom_evidence;
  if (!e || typeof e !== 'object' || typeof containerId !== 'string' || !/^[0-9a-f]{64}$/.test(containerId)) return false;
  if (stage.oom_signal !== 'cgroup' && stage.oom_signal !== 'inspect+cgroup') return false;
  return e.observer === 'armed' && e.container === containerId
    && typeof e.cgroup_path === 'string' && e.cgroup_path.split('/').pop().includes(containerId)
    && e.baseline === 0 && Number.isSafeInteger(e.last) && e.last > 0;
}

module.exports = { classifyStage, cgroupEvidence, oomEvidenced, STAGE_STATES };
