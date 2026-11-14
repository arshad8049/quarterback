"""KAN-111 installed-set check (review 10561). Runs in the grade job after the locked install, before any replay.

    python -I installed-set-check.py <requirements.lock> <swebench-rebuilt-wheel.sha256> [--path=<site-dir>]

Judges the installed environment from the installed distributions' own metadata (importlib.metadata), NOT from
`pip freeze` text: swebench is installed from a local rebuilt wheel (the disclosed source-build exception), which
pip records as a direct reference (direct_url.json; freeze prints `swebench @ file:///…whl`).

Fails (non-zero) unless ALL hold:
  * the set of installed (normalised name, version) pairs equals the lock's, with `pip` itself excluded, and no
    distribution is installed twice;
  * swebench carries direct_url.json pointing to a local file:// wheel whose file name is the rebuilt wheel's,
    and any hash pip recorded for it equals the rebuilt wheel's sha256;
  * no other distribution was installed by direct reference (they came from the hash-checked lock install).
Prints a JSON provenance report on success (saved as install-provenance.json; it is evidence, not a decision).
"""
import importlib.metadata as md
import json
import re
import sys

args = [a for a in sys.argv[1:] if not a.startswith("--path=")]
paths = [a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--path=")]
if len(args) != 2:
    sys.exit("usage: installed-set-check.py <requirements.lock> <swebench-rebuilt-wheel.sha256> [--path=<site-dir>]")
lock_fp, rebuilt_fp = args
norm = lambda n: re.sub(r"[-_.]+", "-", n).lower()  # noqa: E731 (PEP 503)
problems = []

want = {}
for n, v in re.findall(r"^([A-Za-z0-9_.\-]+)==(\S+) --hash=sha256:[0-9a-f]{64}$", open(lock_fp).read(), re.M):
    if norm(n) in want:
        problems.append(f"lock lists {n} twice")
    want[norm(n)] = v
if not want:
    problems.append("no locked distributions parsed")

m = re.match(r"^([0-9a-f]{64})  (swebench-[^/\s]+\.whl)$", open(rebuilt_fp).read().strip())
if not m:
    sys.exit("rebuilt wheel record is not '<sha256>  swebench-*.whl'")
rebuilt_sha, rebuilt_name = m.groups()

dists = list(md.distributions(path=paths) if paths else md.distributions())
have, direct = {}, {}
for d in dists:
    name = d.metadata["Name"]
    if not name:
        problems.append("a distribution has no Name")
        continue
    k = norm(name)
    if k in have:
        problems.append(f"{name} is installed more than once ({have[k]}, {d.version})")
    have[k] = d.version
    raw = d.read_text("direct_url.json")
    if raw is not None:
        direct[k] = json.loads(raw)
have.pop("pip", None)
direct.pop("pip", None)

missing = sorted(k for k in want if k not in have)
different = sorted(k for k in want if k in have and have[k] != want[k])
extra = sorted(k for k in have if k not in want)
if missing:
    problems.append(f"missing: {missing}")
if different:
    problems.append(f"version differs: { {k: (want[k], have[k]) for k in different} }")
if extra:
    problems.append(f"not in the lock: {extra}")

swe = direct.get("swebench")
swe_hash = None
if not swe:
    problems.append("swebench was not installed from the local rebuilt wheel (no direct_url.json)")
else:
    url = swe.get("url", "")
    if not (url.startswith("file://") and url.rsplit("/", 1)[-1] == rebuilt_name):
        problems.append(f"swebench direct reference is not the rebuilt wheel: {url}")
    info = swe.get("archive_info") or {}
    swe_hash = (info.get("hashes") or {}).get("sha256")
    if swe_hash is None and isinstance(info.get("hash"), str) and info["hash"].startswith("sha256="):
        swe_hash = info["hash"].split("=", 1)[1]
    if swe_hash is not None and swe_hash != rebuilt_sha:
        problems.append("the hash pip recorded for swebench differs from the rebuilt wheel")
others = sorted(k for k in direct if k != "swebench")
if others:
    problems.append(f"installed by direct reference, not from the lock: {others}")

if problems:
    print("installed-set check FAILED:\n  " + "\n  ".join(problems), file=sys.stderr)
    sys.exit(1)
print(json.dumps({
    "installed_equals_lock": True, "distributions": len(want), "excluded": ["pip"],
    "swebench": {"version": have["swebench"], "direct_url": swe["url"], "direct_url_sha256": swe_hash,
                 "rebuilt_wheel": rebuilt_name, "rebuilt_wheel_sha256": rebuilt_sha},
    "direct_references_other_than_swebench": 0,
}, indent=2))
