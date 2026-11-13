#!/bin/sh
# KAN-113 10600 §1: READ-ONLY evidence for why bubblewrap cannot create a user namespace. Changes nothing:
# no sysctl writes, no profile loads, no container flag changes. `sudo` is used only to READ the kernel log.
# Prints key=value lines; the qualification script parses them.
set -u
kv() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n' ' ' | cut -c1-400)"; }
rd() { cat "$1" 2>/dev/null || echo unavailable; }
kv sysctl.kernel.apparmor_restrict_unprivileged_userns "$(rd /proc/sys/kernel/apparmor_restrict_unprivileged_userns)"
kv sysctl.kernel.apparmor_restrict_unprivileged_unconfined "$(rd /proc/sys/kernel/apparmor_restrict_unprivileged_unconfined)"
kv sysctl.kernel.unprivileged_userns_clone "$(rd /proc/sys/kernel/unprivileged_userns_clone)"
kv sysctl.user.max_user_namespaces "$(rd /proc/sys/user/max_user_namespaces)"
kv apparmor.enabled "$(rd /sys/module/apparmor/parameters/enabled)"
kv apparmor.bwrap_profile_files "$(ls /etc/apparmor.d 2>/dev/null | grep -i -E 'bwrap|userns|unprivileged' | tr '\n' ',' || true)"
kv host.self_status "$(grep -E '^(Seccomp|NoNewPrivs|CapEff):' /proc/self/status | tr '\t' ' ')"
kv host.unshare_user "$(unshare --user true 2>&1 && echo ok || true)"
kv host.bwrap_present "$(command -v bwrap || echo absent)"
kv docker.security_options "$(docker info -f '{{json .SecurityOptions}}' 2>/dev/null)"
kv docker.default_apparmor_profile_loaded "$(sudo -n cat /sys/kernel/security/apparmor/profiles 2>/dev/null | grep -c '^docker-default' || echo unknown)"
