#!/bin/sh
# Removes the print bridge completely. Run with sudo.
set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo:  sudo $0" >&2
  exit 1
fi

LABEL=la.hankha.print-bridge

launchctl bootout "system/$LABEL" 2>/dev/null || true
rm -f "/Library/LaunchDaemons/$LABEL.plist"
rm -rf /usr/local/hankha/print-bridge
# Leave the log behind on purpose — it is the only record of why a till stopped printing.
pkgutil --forget "$LABEL" >/dev/null 2>&1 || true

# /usr/local/hankha only exists for this package; remove it when nothing else moved in.
rmdir /usr/local/hankha 2>/dev/null || true

echo "hankha-print-bridge removed. Log kept at /var/log/hankha-print-bridge.log"
