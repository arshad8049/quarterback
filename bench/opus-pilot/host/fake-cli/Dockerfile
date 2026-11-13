# KAN-113 10596: the pinned agent image with its CLI replaced by a fake (no model, no credential, no network).
# The image is for host qualification only; its Id is recorded next to the real agent image's Id.
ARG BASE
FROM ${BASE}
USER root
COPY fake-claude.sh /usr/local/bin/claude
RUN chmod 0755 /usr/local/bin/claude && claude --version
USER 10001:10001
