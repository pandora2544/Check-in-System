#!/bin/sh
# รันบน Vercel ทุก deploy: ใส่เลขเวอร์ชัน = เวลา build (UTC) + commit 7 ตัว
# เลขนี้ใช้ทั้งตรวจเวอร์ชันใหม่ (version.json) และบังคับให้ service worker อัปเดต (sw.js)
set -e
SHA=$(printf '%s' "${VERCEL_GIT_COMMIT_SHA:-local000}" | cut -c1-7)
V="$(date -u +%Y%m%d%H%M)-$SHA"
for f in index.html staff.html sw.js version.json; do
  sed -i "s/__APP_VERSION__/$V/g" "$f"
done
echo "CPH Smart Check-in version $V"
