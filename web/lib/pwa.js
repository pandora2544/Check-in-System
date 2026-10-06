/*
 * pwa.js — ใช้ร่วมกันทั้งหน้านักศึกษาและหน้าอาจารย์
 *   1) ลงทะเบียน service worker (/sw.js)
 *   2) ตรวจเวอร์ชันใหม่จาก /version.json → แถบ "มีเวอร์ชันใหม่ แตะเพื่ออัปเดต"
 *      ถ้าเวอร์ชันที่เปิดอยู่เก่ากว่า min_build (แก้ด่วน) → อัปเดตเองเมื่อไม่ได้กำลังสแกนอยู่
 *   3) ปุ่ม/วิธีติดตั้งแอป: Android/คอม = ปุ่มติดตั้ง, iPhone = บอกขั้นตอน "เพิ่มไปยังหน้าจอโฮม"
 *   4) แสดงเลขเวอร์ชันในช่อง #appVersion
 *
 * ตั้งค่าก่อนโหลดไฟล์นี้ (ไม่บังคับ):
 *   window.PWA_OPTS = { isBusy: () => boolean, installSlot: 'elementId', appName: 'ชื่อแอป' }
 */
(function () {
  'use strict';
  const opts = window.PWA_OPTS || {};
  const meta = document.querySelector('meta[name="app-version"]');
  const VERSION = meta ? meta.content : 'dev';
  const IS_DEV = !VERSION || VERSION.startsWith('__') || VERSION === 'dev';
  const build = (v) => String(v || '').split('-')[0]; // 202609301045-abc1234 → 202609301045
  const ua = navigator.userAgent;
  const IS_IOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IN_APP = /FBAN|FBAV|FB_IAB|FB4A|MESSENGER|Line\/|Instagram|KAKAOTALK|; wv\)/i.test(ua);
  const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isBusy = () => { try { return !!opts.isBusy?.(); } catch { return false; } };
  const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ข้าม */ } } };

  // ---------- สไตล์ของแถบ/ปุ่ม (ฝังในไฟล์นี้ ไม่ต้องแก้ CSS ของแต่ละหน้า) ----------
  const css = document.createElement('style');
  css.textContent = `
  .pwa-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom));z-index:50;display:flex;gap:10px;align-items:center;
    background:#173029;color:#fff;border-radius:14px;padding:10px 12px 10px 16px;box-shadow:0 8px 24px rgba(0,0,0,.25);font-size:14px;max-width:calc(100vw - 32px);width:max-content}
  .pwa-bar button{font:inherit;font-weight:700;border:none;border-radius:10px;padding:8px 12px;cursor:pointer}
  .pwa-bar .go{background:#F2C45C;color:#173029}.pwa-bar .x{background:transparent;color:#cfd8d3;padding:8px}
  .pwa-install{display:flex;gap:10px;align-items:center;background:#fff;border:1px solid #D8DED9;border-radius:14px;padding:10px 12px;margin:0 0 12px;font-size:13.5px;color:#173029}
  .pwa-install img{width:36px;height:36px;border-radius:9px;flex:none}.pwa-install .t{flex:1;min-width:0}.pwa-install .t b{display:block;font-size:14px}
  .pwa-install button{font:inherit;font-weight:700;border:none;border-radius:10px;padding:8px 12px;cursor:pointer;background:#3C6E58;color:#fff;white-space:nowrap}
  .pwa-install .x{background:transparent;color:#587067;padding:6px}
  .pwa-sheet{position:fixed;inset:0;z-index:60;background:rgba(10,20,16,.55);display:flex;align-items:flex-end;justify-content:center}
  .pwa-sheet .box{background:#fff;color:#173029;width:100%;max-width:460px;border-radius:18px 18px 0 0;padding:20px 20px calc(20px + env(safe-area-inset-bottom));font-size:15px}
  .pwa-sheet h3{margin:0 0 12px;font-size:17px}.pwa-sheet ol{margin:0 0 14px;padding-left:22px;line-height:1.9}
  .pwa-sheet .ico{display:inline-flex;vertical-align:-5px;width:22px;height:22px}
  .pwa-sheet button{font:inherit;font-weight:700;width:100%;border:none;border-radius:12px;padding:12px;background:#3C6E58;color:#fff;cursor:pointer}`;
  document.head.appendChild(css);

  const vEl = document.getElementById('appVersion');
  if (vEl) vEl.textContent = IS_DEV ? 'เวอร์ชันทดสอบ (ไม่ได้ build)' : `เวอร์ชัน ${VERSION}${STANDALONE ? ' · แอป' : ''}`;

  // ---------- 1) service worker ----------
  let reg = null;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((r) => { reg = r; }).catch(() => {});
    });
  }

  // ---------- 2) อัปเดตเวอร์ชัน ----------
  let bar = null, reloading = false, lastCheck = 0;
  function whenIdle(fn) {
    if (!isBusy()) return fn();
    const t = setInterval(() => { if (!isBusy()) { clearInterval(t); fn(); } }, 1500);
  }
  function applyUpdate() {
    if (reloading) return;
    reloading = true;
    whenIdle(async () => {
      try { await reg?.update(); } catch { /* ข้าม */ }
      location.reload();
    });
  }
  function showUpdateBar(next) {
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'pwa-bar'; bar.setAttribute('role', 'status');
    bar.innerHTML = '<span>🔄 มีเวอร์ชันใหม่</span><button class="go">อัปเดต</button><button class="x" aria-label="ปิด">✕</button>';
    bar.querySelector('.go').onclick = () => { bar.querySelector('.go').textContent = 'กำลังอัปเดต…'; applyUpdate(); };
    bar.querySelector('.x').onclick = () => { bar.remove(); bar = null; lastCheck = Date.now() + 20 * 60e3; }; // เลื่อนไป ~30 นาที
    bar.title = next;
    document.body.appendChild(bar);
  }
  async function checkVersion(force = false) {
    if (IS_DEV || !navigator.onLine) return;
    if (!force && Date.now() - lastCheck < 10 * 60e3) return;
    lastCheck = Date.now();
    try {
      const res = await fetch('/version.json', { cache: 'no-store' });
      if (!res.ok) return;
      const v = await res.json();
      if (!v.version || v.version === VERSION || v.version.startsWith('__')) return;
      if (v.min_build && build(VERSION) < String(v.min_build)) applyUpdate(); // แก้ด่วน — อัปเดตเอง (รอจนไม่ได้สแกนอยู่)
      else showUpdateBar(v.version);
    } catch { /* ออฟไลน์ */ }
  }
  setTimeout(() => checkVersion(true), 4000);
  setInterval(() => { if (!document.hidden) checkVersion(); }, 30 * 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });

  // ---------- 3) ติดตั้งแอป ----------
  const DISMISS_KEY = 'cph_pwa_install_dismissed';
  const dismissedRecently = () => Number(ls.get(DISMISS_KEY) || 0) > Date.now() - 14 * 86400e3;
  let deferred = null, card = null;
  const appName = opts.appName || 'CSE-SMART-LAB';

  function slot() { return opts.installSlot ? document.getElementById(opts.installSlot) : null; }
  function showInstallCard(onInstall) {
    const where = slot();
    if (!where || card || STANDALONE || dismissedRecently()) return;
    card = document.createElement('div');
    card.className = 'pwa-install';
    card.innerHTML = `<img src="/icons/icon-192.png" alt=""><div class="t"><b>ติดตั้ง ${appName} เป็นแอป</b>เปิดจากหน้าจอหลักได้ทันที โหลดเร็วขึ้น</div>
      <button class="go">ติดตั้ง</button><button class="x" aria-label="ไม่ใช่ตอนนี้">✕</button>`;
    card.querySelector('.go').onclick = onInstall;
    card.querySelector('.x').onclick = () => { ls.set(DISMISS_KEY, String(Date.now())); card.remove(); card = null; };
    where.appendChild(card);
  }
  function hideInstallCard() { card?.remove(); card = null; }

  window.addEventListener('beforeinstallprompt', (e) => { // Android Chrome/Samsung/Edge, คอม Chrome/Edge
    e.preventDefault(); deferred = e;
    showInstallCard(async () => {
      if (!deferred) return;
      deferred.prompt();
      const choice = await deferred.userChoice.catch(() => null);
      deferred = null;
      if (choice?.outcome === 'accepted') hideInstallCard();
    });
  });
  window.addEventListener('appinstalled', () => { hideInstallCard(); ls.set(DISMISS_KEY, String(Date.now() + 3650 * 86400e3)); });

  const SHARE_ICON = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="#2F6FED" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/></svg>';
  const ADD_ICON = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="#173029" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
  function iosSheet() {
    const s = document.createElement('div');
    s.className = 'pwa-sheet';
    s.innerHTML = `<div class="box" role="dialog" aria-label="วิธีติดตั้งบน iPhone">
      <h3>ติดตั้งเป็นแอปบน iPhone</h3>
      <ol>
        <li>แตะปุ่ม <b>แชร์</b> ${SHARE_ICON} ที่แถบล่าง (หรือบนขวาใน iPad)</li>
        <li>เลื่อนลงแล้วแตะ <b>เพิ่มไปยังหน้าจอโฮม</b> ${ADD_ICON}</li>
        <li>แตะ <b>เพิ่ม</b> มุมขวาบน — ไอคอนจะอยู่บนหน้าจอโฮม</li>
      </ol>
      <div style="font-size:13px;color:#587067;margin:-4px 0 14px">ครั้งแรกที่เปิดจากไอคอน แอปจะขอสิทธิ์กล้องและตำแหน่งอีกครั้ง ให้กด "อนุญาต"</div>
      <button>เข้าใจแล้ว</button></div>`;
    s.onclick = (e) => { if (e.target === s || e.target.tagName === 'BUTTON') s.remove(); };
    document.body.appendChild(s);
  }
  // iPhone: ไม่มี beforeinstallprompt → แสดงการ์ดพร้อมขั้นตอนเอง (ไม่แสดงในเบราว์เซอร์ในแอป เพราะหน้าเว็บบอกให้เปิดใน Safari อยู่แล้ว)
  if (IS_IOS && !STANDALONE && !IN_APP) window.addEventListener('load', () => setTimeout(() => showInstallCard(iosSheet), 1500));

  window.PWA = { version: VERSION, standalone: STANDALONE, checkVersion: () => checkVersion(true), applyUpdate };
})();
