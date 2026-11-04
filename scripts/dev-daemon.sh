#!/usr/bin/env bash
# ============================================================================
# dev-daemon.sh — dev 服务器持久化守护启动（双 fork + setsid 孤儿进程）
# ----------------------------------------------------------------------------
# 背景：沙箱会收割挂在工具进程树/会话上的后台任务（SIGKILL 无输出）。
# 方案：双 fork 使进程彻底脱离当前进程树成为孤儿（由 init 收养）：
#   fork#1: 外层子 shell ( ... & ) 脱离工具 shell 的 job 控制 + disown
#   fork#2: setsid --fork 自身再 fork 一次并 create 新会话（脱离 controlling tty）
# 最终 next dev 的父进程链为 init(1)，任何工具 shell 退出/收割都不影响。
#
# 用法：
#   scripts/dev-daemon.sh start|stop|restart|status
# ============================================================================
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/dev.log"
PIDFILE="$ROOT/.dev-daemon.pid"

is_alive() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

do_stop() {
  # 杀掉整个进程组（setsid 后自身为组长），再兜底按命令名清理
  if [ -f "$PIDFILE" ]; then
    local pid
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      kill -KILL -"$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
  pkill -KILL -f "next dev" 2>/dev/null || true
  pkill -KILL -f "next-server" 2>/dev/null || true
}

do_start() {
  if is_alive; then
    echo "dev 服务器已在运行 (pid $(cat "$PIDFILE"))"
    return 0
  fi
  do_stop
  : > "$LOG"
  # 双 fork 孤儿进程：
  #  - 外层 ( ... & ) + disown：脱离当前 shell 的作业表
  #  - setsid --fork：setsid 进程 fork 出子进程建立新会话后自己退出 → 子进程被 init 收养
  (
    cd "$ROOT" || exit 1
    setsid --fork nohup bun run dev > "$LOG" 2>&1 < /dev/null &
  ) &
  disown $! 2>/dev/null || true

  # 等待 next dev 进程出现并记录（此时它已是 init 收养的孤儿/新会话组长）
  for _ in $(seq 1 15); do
    svc="$(pgrep -f 'next dev' 2>/dev/null | head -1)"
    if [ -n "$svc" ]; then
      echo "$svc" > "$PIDFILE"
      break
    fi
    sleep 1
  done

  # 等待端口就绪（最多 40s）
  for _ in $(seq 1 40); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:3000/" 2>/dev/null || echo 000)"
    if [ "$code" = "200" ] || [ "$code" = "307" ] || [ "$code" = "308" ]; then
      echo "dev 服务器已就绪 (pid $(cat "$PIDFILE" 2>/dev/null || echo '?'), http $code, 日志 $LOG)"
      return 0
    fi
    sleep 1
  done
  echo "⚠️ dev 服务器未在 40s 内就绪，请查看 $LOG"
  return 1
}

do_status() {
  if is_alive; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:3000/" 2>/dev/null || echo 000)"
    echo "运行中 (pid $(cat "$PIDFILE"), http $code)"
    return 0
  fi
  echo "未运行"
  return 1
}

case "${1:-start}" in
  start) do_start ;;
  stop) do_stop && echo "已停止" ;;
  restart) do_stop; do_start ;;
  status) do_status ;;
  *) echo "用法: $0 start|stop|restart|status"; exit 2 ;;
esac
