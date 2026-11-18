# Quarterback agent image, U2 version (KAN-114 10720): the v8 agent image plus a headless-capable Chromium, shared by
# BOTH arms. Build context is sandbox/ (it reuses the unchanged sandbox/agent/ files; that directory is not modified,
# so the v8 image and its content tag stay as they were):
#   docker build -f sandbox/agent-u2/Dockerfile sandbox/
# - Base: the exact node digest the v8 (kan117) image set was built from (Node v24.22.3). No floating tag.
# - Packages: Debian bookworm from snapshot.debian.org at a fixed timestamp, so a rebuild resolves the same versions;
#   the build records the installed chromium version. The saved image digest is what gets frozen.
# - Browser sandbox: nothing here disables or weakens it (no browser flags, no privileged helper, no syscall-filter
#   change). Whether it can start under QB's container hardening is measured by the build probe and reported.
# - Runs as uid 10001 with no network at task time (hardening comes from QB's docker run flags, unchanged).
FROM node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ARG CLAUDE_VERSION=2.1.322
ARG DEBIAN_SNAPSHOT=20261115T000000Z
RUN rm -f /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list \
 && printf '%s\n' \
    "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main" \
    "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm-updates main" \
    "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} bookworm-security main" \
    > /etc/apt/sources.list \
 && apt-get -o Acquire::Retries=5 update \
 && apt-get install -y --no-install-recommends socat git ca-certificates curl chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
 && npm cache clean --force
ENV CHROME_BIN=/usr/bin/chromium
COPY agent/managed-settings.json /etc/claude-code/managed-settings.json
COPY agent/entry.sh /usr/local/lib/qb/agent-entry.sh
COPY agent/agent-run.sh /usr/local/lib/qb/agent-run.sh
COPY agent/deps-install.sh /usr/local/lib/qb/deps-install.sh
COPY agent/qb-test-reporter.mjs /usr/local/lib/qb/qb-test-reporter.mjs
COPY agent/qb-check-runner.mjs /usr/local/lib/qb/qb-check-runner.mjs
RUN chmod 0755 /usr/local/lib/qb/agent-entry.sh /usr/local/lib/qb/agent-run.sh /usr/local/lib/qb/deps-install.sh \
 && chmod 0644 /usr/local/lib/qb/qb-test-reporter.mjs /usr/local/lib/qb/qb-check-runner.mjs
