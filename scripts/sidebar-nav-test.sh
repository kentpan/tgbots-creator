#!/bin/bash
# 侧边栏多轮切换测试 v2：xpath 定位组按钮（先探测是否已展开，避免重复点击收起），CSS 定位链接
export PATH=/tmp/ab/node_modules/.bin:$PATH

url() { agent-browser get url 2>/dev/null | tail -1; }
count() { agent-browser get count "$1" 2>/dev/null | tail -1; }

click_link() {
  local sel="$1" name="$2"
  local out u
  out=$(agent-browser click "$sel" 2>&1 | tail -1)
  sleep 2.5
  u=$(url)
  if [[ "$out" == *"✗"* ]]; then
    echo "FAIL-CLICK [$name] err=$out url=$u"
  else
    echo "OK [$name] -> $u"
  fi
}

expand_group() {
  local btnsel="$1" name="$2" probe="$3"
  if [[ "$(count "$probe")" == "0" ]]; then
    local out
    out=$(agent-browser click "$btnsel" 2>&1 | tail -1)
    sleep 1
    if [[ "$(count "$probe")" == "0" ]]; then
      echo "EXPAND-FAIL [$name] out=$out"
    fi
  fi
}

echo "=== start at $(url) ==="
fail=0; total=0
for round in 1 2 3 4; do
  echo "--- round $round ---"
  expand_group 'xpath=//aside//button[contains(., "机器人")]' '机器人组' 'a[href="/admin/bots"]'
  expand_group 'xpath=//aside//button[contains(., "群组")]' '群组组' 'a[href="/admin/groups"]'
  for pair in \
    'a[href="/admin/bots"]|机器人管理' \
    'a[href="/admin/bots/testing"]|APP仿真' \
    'a[href="/admin/bots/commands"]|指令管理' \
    'a[href="/admin/tgapi"]|TGAPI申请' \
    'a[href="/admin/developer-accounts"]|开发者账号' \
    'a[href="/admin/join-requests"]|加群申请' \
    'a[href="/admin/groups"]|群组管理' \
    'a[href="/admin/verification-methods"]|验证方式' \
    'a[href="/admin/users"]|系统用户' \
    'a[href="/admin/roles"]|角色权限' \
    'a[href="/admin/menus"]|菜单管理' \
    'a[href="/admin/settings"]|系统设置' \
    'a[href="/admin/ai"]|AI配置' \
    'a[href="/admin/backup"]|备份管理' \
    'a[href="/admin/api-logs"]|API日志' \
    'a[href="/admin/logs"]|操作日志' \
    'a[href="/admin"]|控制台'; do
    sel="${pair%%|*}"; name="${pair##*|}"
    total=$((total+1))
    r=$(click_link "$sel" "$name")
    echo "$r"
    [[ "$r" == FAIL* ]] && fail=$((fail+1))
  done
done
echo "=== done: $fail failures / $total clicks, final url=$(url) ==="
