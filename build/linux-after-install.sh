#!/bin/bash
# Ubuntu 23.10+ sets kernel.apparmor_restrict_unprivileged_userns=1, which stops
# any unprofiled binary from creating a user namespace. Chromium's sandbox needs
# one, and electron-builder's own postinst leaves chrome-sandbox non-setuid
# (its check runs as root, where unshare always succeeds). Without one of the
# two, Cozy refuses to start with "The SUID sandbox helper binary was found, but
# is not configured correctly".
#
# Grant the userns capability by name rather than disabling the sandbox.
set -e

APPARMOR_PROFILE="/etc/apparmor.d/cozy"

if [ -d /etc/apparmor.d ] && [ -e /sys/kernel/security/apparmor ]; then
  cat > "$APPARMOR_PROFILE" <<'PROFILE'
# This profile allows everything and only exists to give the
# application a name instead of having the label "unconfined"
abi <abi/4.0>,
include <tunables/global>

profile cozy /opt/Cozy/cozy flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/cozy>
}
PROFILE
  if command -v apparmor_parser > /dev/null 2>&1; then
    apparmor_parser -r "$APPARMOR_PROFILE" || true
  fi
else
  # No AppArmor: fall back to the setuid sandbox helper, which is what
  # Chromium uses on every other distribution.
  chmod 4755 '/opt/Cozy/chrome-sandbox' || true
fi
