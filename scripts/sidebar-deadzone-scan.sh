#!/bin/bash
# 逐页扫描侧边栏链接中心点遮挡情况：定位"点击菜单无反应"死区
export PATH=/tmp/ab/node_modules/.bin:$PATH

PAGES="/admin /admin/bots /admin/bots/testing /admin/bots/commands /admin/tgapi /admin/developer-accounts /admin/join-requests /admin/groups /admin/verification-methods /admin/users /admin/roles /admin/menus /admin/settings /admin/ai /admin/backup /admin/api-logs /admin/logs"

for p in $PAGES; do
  agent-browser open "http://localhost:3000$p" >/dev/null 2>&1
  sleep 2
  echo "=== $p ==="
  agent-browser eval "
(() => {
  const aside = document.querySelector('aside');
  const links = [...aside.querySelectorAll('nav a, nav span[aria-current=page]')];
  const bad = [];
  for (const a of links) {
    const r = a.getBoundingClientRect();
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    const hit = document.elementFromPoint(cx, cy);
    const ok = a.contains(hit) || hit === a;
    if (!ok && cy < 577) bad.push({t: a.textContent.trim().slice(0,10), cy: Math.round(cy), hit: hit ? (hit.className||'').toString().slice(0,40) : 'none'});
  }
  const nav = aside.querySelector('nav');
  return JSON.stringify({clipped: Math.round(nav.scrollHeight - nav.clientHeight), bad});
})()
" 2>&1 | tail -1
done
