#!/bin/sh
# Fake docker for the cleanup gate: FAKE_DOCKER_IDS_<kind> = number of ids to print; FAKE_DOCKER_FAIL=1 makes it fail.
[ "${FAKE_DOCKER_FAIL:-0}" = 1 ] && { echo "fake docker: daemon unavailable" >&2; exit 1; }
case "$1 $2" in
  "ps -aq") n=${FAKE_DOCKER_IDS_containers:-0} ;;
  "volume ls")
    case "$*" in *qb-claude-auth*) n=${FAKE_DOCKER_IDS_auth:-0} ;; *) n=${FAKE_DOCKER_IDS_volumes:-0} ;; esac ;;
  "network ls") n=${FAKE_DOCKER_IDS_networks:-0} ;;
  *) echo "fake docker: unexpected $*" >&2; exit 2 ;;
esac
i=0; while [ "$i" -lt "$n" ]; do echo "id$i"; i=$((i+1)); done
