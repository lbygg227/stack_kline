#!/usr/bin/env bash
#
# 一键启动 A 股研究终端
#   - 自检运行环境（node/npm）、依赖、.env
#   - 后台启动 Vite dev server（含行情服务、调度器、Cloudflare 隧道）
#   - 等待 /api/health 就绪，打印本机地址与公网地址
#
# 用法：
#   ./scripts/start.sh                 后台启动并返回访问地址
#   ./scripts/start.sh stop            停止
#   ./scripts/start.sh restart         重启
#   ./scripts/start.sh status          查看运行状态（进程/端口/健康/隧道）
#   ./scripts/start.sh logs [-f]       查看日志（-f 持续跟踪）
#   ./scripts/start.sh health          逐个探测关键接口
#
# 可选参数（放在命令前后均可）：
#   --port 5180      指定端口（默认 5173）
#   --host           监听 0.0.0.0，便于局域网/手机访问
#   --no-tunnel      不启动 Cloudflare 公网隧道
#   --no-install     缺依赖时不自动 npm install
#   --force          端口被占用时强制结束占用进程
#   --foreground     前台运行（Ctrl+C 结束）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"
DEFAULT_PORT=5173
READY_TIMEOUT="${READY_TIMEOUT:-120}"
TUNNEL_WAIT="${TUNNEL_WAIT:-30}"

PORT="${PORT:-$DEFAULT_PORT}"
PID_FILE=""
LOG_FILE=""
HOST_BIND="127.0.0.1"
ENABLE_TUNNEL=1
AUTO_INSTALL=1
FORCE=0
FOREGROUND=0
FOLLOW=0

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_BOLD=''
fi

info() { printf '%s\n' "${C_BLUE}▸${C_RESET} $*"; }
ok()   { printf '%s\n' "${C_GREEN}✔${C_RESET} $*"; }
warn() { printf '%s\n' "${C_YELLOW}!${C_RESET} $*"; }
err()  { printf '%s\n' "${C_RED}✘${C_RESET} $*" >&2; }

usage() {
  # 打印文件头部的注释块（跳过 shebang，遇到第一行非注释即停止）
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

# PID 与日志按端口隔离，支持同时跑多个实例（默认端口仍用 dev.pid / dev.log）
resolve_run_files() {
  if [ "$PORT" = "$DEFAULT_PORT" ]; then
    PID_FILE="$RUN_DIR/dev.pid"
    LOG_FILE="$RUN_DIR/dev.log"
  else
    PID_FILE="$RUN_DIR/dev-$PORT.pid"
    LOG_FILE="$RUN_DIR/dev-$PORT.log"
  fi
}

# ---------- 基础检查 ----------

have() { command -v "$1" >/dev/null 2>&1; }

check_prereq() {
  if ! have node; then
    err "未找到 node，请先安装 Node.js 20+（推荐 22）"
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${major:-0}" -lt 20 ]; then
    warn "Node 版本偏低（$(node -v)），建议 20 以上"
  fi
  if ! have npm; then
    err "未找到 npm"
    exit 1
  fi
  if ! have curl; then
    warn "未找到 curl，就绪检测会降级为端口探测"
  fi
}

ensure_dirs() { mkdir -p "$RUN_DIR"; }

ensure_env() {
  if [ ! -f "$ROOT/.env" ]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    warn "已从 .env.example 生成 .env，AI/观点/资金等需要 key 的功能请按需填写"
  fi
}

ensure_deps() {
  if [ -x "$ROOT/node_modules/.bin/vite" ]; then
    return 0
  fi
  if [ "$AUTO_INSTALL" -eq 0 ]; then
    err "依赖未安装（缺少 node_modules/.bin/vite），请先执行 npm install"
    exit 1
  fi
  info "首次运行，正在安装依赖（npm install）…"
  ( cd "$ROOT" && npm install ) || { err "依赖安装失败"; exit 1; }
  ok "依赖安装完成"
}

# ---------- 进程/端口 ----------

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

port_pid() {
  local port="$1"
  if have lsof; then
    lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | head -1
    return 0
  fi
  if have ss; then
    ss -ltnp 2>/dev/null | grep -E "[:.]$port[[:space:]]" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
    return 0
  fi
  return 1
}

http_code() {
  local url="$1" code=''
  if have curl; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)" || code=''
    printf '%s' "${code:-000}"
  else
    if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1; then printf '200'; else printf '000'; fi
  fi
}

wait_ready() {
  local pid="$1" waited=0 code
  info "等待服务就绪（最多 ${READY_TIMEOUT}s）…"
  while [ "$waited" -lt "$READY_TIMEOUT" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      err "进程已退出，最近日志："
      tail -n 25 "$LOG_FILE" 2>/dev/null | sed 's/^/    /'
      return 1
    fi
    code="$(http_code "http://127.0.0.1:$PORT/api/health")"
    if [ "$code" = "200" ]; then
      printf '\r\033[K'
      ok "服务就绪（${waited}s）"
      return 0
    fi
    if [ -t 1 ]; then
      printf '\r%s' "${C_DIM}  … 已等待 ${waited}s / ${READY_TIMEOUT}s（/api/health = ${code}）${C_RESET}"
    fi
    sleep 2
    waited=$((waited + 2))
  done
  printf '\r\033[K'
  warn "等待超时，服务可能仍在初始化；可执行 ./scripts/start.sh logs -f 查看进度"
  return 1
}

tunnel_url() {
  [ -f "$LOG_FILE" ] || return 1
  grep -aohE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | tail -1
}

wait_tunnel() {
  local waited=0 url
  while [ "$waited" -lt "$TUNNEL_WAIT" ]; do
    url="$(tunnel_url || true)"
    if [ -n "${url:-}" ]; then printf '%s' "$url"; return 0; fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

lan_ip() {
  if have hostname; then
    hostname -I 2>/dev/null | awk '{print $1}'
  fi
}

print_summary() {
  local tunnel="$1"
  printf '\n%s\n' "${C_BOLD}================ 启动完成 ================${C_RESET}"
  printf '  %s本机访问%s  http://127.0.0.1:%s/\n' "$C_BOLD" "$C_RESET" "$PORT"
  if [ "$HOST_BIND" = "0.0.0.0" ]; then
    local ip; ip="$(lan_ip || true)"
    [ -n "${ip:-}" ] && printf '  %s局域网%s    http://%s:%s/\n' "$C_BOLD" "$C_RESET" "$ip" "$PORT"
  fi
  if [ -n "$tunnel" ]; then
    printf '  %s公网访问%s  %s\n' "$C_BOLD" "$C_RESET" "$tunnel"
  elif [ "$ENABLE_TUNNEL" -eq 1 ]; then
    printf '  %s公网访问%s  隧道尚未就绪（可能被 Cloudflare 限流），稍后执行 ./scripts/start.sh status 查看\n' "$C_BOLD" "$C_RESET"
  else
    printf '  %s公网访问%s  已禁用（--no-tunnel）\n' "$C_BOLD" "$C_RESET"
  fi
  printf '  %s日志%s      %s\n' "$C_BOLD" "$C_RESET" "$LOG_FILE"
  if [ "$PORT" = "$DEFAULT_PORT" ]; then
    printf '  %s停止%s      ./scripts/start.sh stop\n' "$C_BOLD" "$C_RESET"
  else
    printf '  %s停止%s      ./scripts/start.sh stop --port %s\n' "$C_BOLD" "$C_RESET" "$PORT"
  fi
  printf '%s\n\n' "${C_BOLD}==========================================${C_RESET}"
}

# ---------- 命令 ----------

cmd_start() {
  check_prereq
  ensure_dirs

  local pid
  if pid="$(running_pid)"; then
    ok "服务已在运行（PID $pid）"
    print_summary "$(tunnel_url || true)"
    return 0
  fi

  local occupant
  occupant="$(port_pid "$PORT" || true)"
  if [ -n "${occupant:-}" ]; then
    if [ "$FORCE" -eq 1 ]; then
      warn "端口 $PORT 被 PID $occupant 占用，已按 --force 结束该进程"
      kill -TERM "$occupant" 2>/dev/null || true
      sleep 2
      kill -KILL "$occupant" 2>/dev/null || true
    else
      err "端口 $PORT 已被 PID $occupant 占用（可能是上一次未正常退出的服务）"
      err "可执行：./scripts/start.sh stop   或   ./scripts/start.sh restart --force   或   ./scripts/start.sh start --port 5180"
      exit 1
    fi
  fi

  ensure_env
  ensure_deps

  : > "$LOG_FILE"
  local args=("--port" "$PORT")
  [ "$HOST_BIND" = "0.0.0.0" ] && args+=("--host" "0.0.0.0")

  if [ "$FOREGROUND" -eq 1 ]; then
    info "前台启动（Ctrl+C 结束）…"
    STOCK_KLINE_TUNNEL="$ENABLE_TUNNEL" PORT="$PORT" HOST="$HOST_BIND" \
      npm --prefix "$ROOT" run dev -- "${args[@]}"
    return $?
  fi

  info "启动服务：npm run dev ${args[*]}"
  ( cd "$ROOT" && STOCK_KLINE_TUNNEL="$ENABLE_TUNNEL" PORT="$PORT" HOST="$HOST_BIND" \
      setsid nohup npm run dev -- "${args[@]}" >>"$LOG_FILE" 2>&1 </dev/null & echo $! >"$PID_FILE" )

  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "${pid:-}" ]; then
    err "启动失败：未取得进程号，请查看日志 $LOG_FILE"
    exit 1
  fi

  if ! wait_ready "$pid"; then
    exit 1
  fi

  local tunnel=''
  if [ "$ENABLE_TUNNEL" -eq 1 ]; then
    info "等待公网隧道地址…"
    tunnel="$(wait_tunnel || true)"
    [ -z "$tunnel" ] && warn "隧道暂未就绪（Cloudflare 快速隧道偶发限流），服务本身可正常使用"
  fi
  print_summary "$tunnel"
}

# 收集需要结束的进程：PID 文件、端口占用者、本项目 vite、本端口的 cloudflared
collect_targets() {
  local pid portpid tree tunnel
  pid="$(running_pid || true)"
  portpid="$(port_pid "$PORT" || true)"
  tree="$(pgrep -f "$ROOT/node_modules/.bin/vite" 2>/dev/null | tr '\n' ' ' || true)"
  tunnel="$(pgrep -f "cloudflared tunnel --url http://127.0.0.1:$PORT" 2>/dev/null | tr '\n' ' ' || true)"
  printf '%s %s %s %s' "${pid:-}" "${portpid:-}" "${tree:-}" "${tunnel:-}"
}

cmd_stop() {
  local targets
  targets="$(collect_targets)"
  local -a pids=()
  local item
  for item in $targets; do
    [ -n "$item" ] || continue
    local dup=0
    for existing in "${pids[@]:-}"; do
      [ "$existing" = "$item" ] && dup=1
    done
    [ "$dup" -eq 1 ] || pids+=("$item")
  done

  if [ "${#pids[@]}" -eq 0 ]; then
    info "服务未在运行"
    rm -f "$PID_FILE"
    return 0
  fi

  info "停止服务（PID：${pids[*]}）…"
  for item in "${pids[@]}"; do
    kill -TERM "-$item" 2>/dev/null || kill -TERM "$item" 2>/dev/null || true
  done

  # 等待端口释放（最多 20s）
  local waited=0 code
  while [ "$waited" -lt 20 ]; do
    code="$(http_code "http://127.0.0.1:$PORT/api/health")"
    if [ "$code" != "200" ] && [ -z "$(port_pid "$PORT" || true)" ]; then
      rm -f "$PID_FILE"
      ok "已停止（${waited}s）"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  warn "仍有进程占用端口 $PORT，强制结束"
  for item in $(collect_targets); do
    [ -n "$item" ] || continue
    kill -KILL "-$item" 2>/dev/null || kill -KILL "$item" 2>/dev/null || true
  done
  sleep 2
  rm -f "$PID_FILE"
  if [ -n "$(port_pid "$PORT" || true)" ]; then
    err "端口 $PORT 仍被占用，请手动检查：ss -ltnp | grep $PORT"
    return 1
  fi
  ok "已停止"
}

cmd_status() {
  ensure_dirs
  local pid code=000 tunnel_live tunnel_pid
  printf '%s服务状态%s\n' "$C_BOLD" "$C_RESET"
  if pid="$(running_pid)"; then
    printf '  进程      %s运行中%s（PID %s）\n' "$C_GREEN" "$C_RESET" "$pid"
  else
    printf '  进程      %s未运行%s\n' "$C_YELLOW" "$C_RESET"
  fi
  code="$(http_code "http://127.0.0.1:$PORT/api/health")"
  if [ "$code" = "200" ]; then
    printf '  健康检查  %s200 OK%s  http://127.0.0.1:%s/api/health\n' "$C_GREEN" "$C_RESET" "$PORT"
  else
    printf '  健康检查  %s%s%s\n' "$C_YELLOW" "$code" "$C_RESET"
  fi
  printf '  端口      %s\n' "$PORT"
  if have curl; then
    tunnel_live="$(curl -s --max-time 5 "http://127.0.0.1:$PORT/api/tunnel" 2>/dev/null || true)"
    if [ -n "$tunnel_live" ]; then
      printf '  隧道      %s\n' "$tunnel_live"
    fi
  fi
  tunnel_pid="$(pgrep -f "cloudflared tunnel --url http://127.0.0.1:$PORT" 2>/dev/null | head -1 || true)"
  [ -n "${tunnel_pid:-}" ] && printf '  隧道进程  cloudflared PID %s\n' "$tunnel_pid"
  printf '  日志      %s\n' "$LOG_FILE"
  [ -f "$LOG_FILE" ] && printf '  最后一行  %s\n' "$(grep -v '^[[:space:]]*$' "$LOG_FILE" 2>/dev/null | tail -n 1)"
}

cmd_logs() {
  [ -f "$LOG_FILE" ] || { err "暂无日志文件（$LOG_FILE）"; exit 1; }
  if [ "$FOLLOW" -eq 1 ]; then
    tail -n 80 -f "$LOG_FILE"
  else
    tail -n "${LINES:-120}" "$LOG_FILE"
  fi
}

cmd_health() {
  local base="http://127.0.0.1:$PORT"
  local paths=(
    "/api/health"
    "/api/recommendations"
    "/api/recommendations/attribution"
    "/api/recommendations/weights"
    "/api/digest"
    "/api/simulation"
  )
  printf '%s接口探测%s %s\n' "$C_BOLD" "$C_RESET" "$base"
  local failed=0 code
  for p in "${paths[@]}"; do
    if have curl; then
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 "$base$p" 2>/dev/null)" || code='000'
    else
      code="$(http_code "$base$p")"
    fi
    if [ "$code" = "200" ]; then
      printf '  %s✔%s %-42s %s\n' "$C_GREEN" "$C_RESET" "$p" "$code"
    else
      printf '  %s✘%s %-42s %s\n' "$C_RED" "$C_RESET" "$p" "$code"
      failed=$((failed + 1))
    fi
  done
  [ "$failed" -eq 0 ] && ok "全部接口正常" || warn "$failed 个接口异常"
}

# ---------- 参数解析 ----------

COMMAND="start"
while [ $# -gt 0 ]; do
  case "$1" in
    start|stop|restart|status|logs|health|help|-h|--help) COMMAND="$1"; shift ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --host) HOST_BIND="0.0.0.0"; shift ;;
    --no-tunnel) ENABLE_TUNNEL=0; shift ;;
    --no-install) AUTO_INSTALL=0; shift ;;
    --force) FORCE=1; shift ;;
    --foreground) FOREGROUND=1; shift ;;
    --follow|-f) FOLLOW=1; shift ;;
    *) err "未知参数：$1"; usage; exit 1 ;;
  esac
done

resolve_run_files

case "$COMMAND" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  health) cmd_health ;;
  help|-h|--help) usage ;;
esac
