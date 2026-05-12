# mobile-cc

给命令行版 Claude Code 套一个网页壳（手机优先）。后端是 FastAPI，spawn `claude` 子进程把 NDJSON 流转成 SSE 喂给浏览器；前端是 React 的 chat UI，支持 markdown / 思考块 / 工具调用卡片 / 权限审批 / 文件预览 / 历史会话 / `/` 联想 skills / `@` 联想文件。

## 三种用法

| | 适合场景 | 浏览器访问 |
|---|---|---|
| **A. 仅本地** | 自己电脑跑，同一台机器的浏览器访问 | `http://127.0.0.1:8788` |
| **B. Cloudflare Tunnel** | 没有公网 IP（家用 / CGNAT），想用手机访问 | cloudflared 给的 `https://xxx.trycloudflare.com` |
| **C. 公网 IP + TLS** | 服务器有真公网 IP 和域名 | `https://你的域名:8443` |

API key 等于完整 shell 权限（用户让 claude 调 Bash 然后自己点 allow 就行），所以**远程访问一定要用 HTTPS**——B 和 C 都自带，A 不出本机不用管。

## 快速开始（公共部分）

前置（macOS / Linux / Windows 通用）：
- [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code)（`claude` 在 PATH）
- Python 3.12+
- Node 20+
- [uv](https://docs.astral.sh/uv/)

各平台装 uv（如果还没有）：

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
# 或 winget install --id=astral-sh.uv -e
```

接下来三平台一样：

```bash
cd mobile-cc
uv sync
cd web && npm install && npm run build && cd ..

# 复制并编辑配置：填 allowed_dirs
cp config.example.toml config.toml      # Windows PowerShell: copy config.example.toml config.toml
```

`allowed_dirs` 列表里每一项都会出现在「新建会话」的目录下拉里，claude 启动时 cwd 就是你选的那个目录。**用户不能在 web 上自由填路径，只能从这个白名单里选**。

首次启动会在项目根生成 `.api-key` 并把它打印到终端——这串就是浏览器登录用的密钥。

---

## A. 仅本地

```bash
uv run python -m mobile_cc --port 8788 --host 127.0.0.1
```

浏览器开 `http://127.0.0.1:8788`，输 API key，开聊。

---

## B. Cloudflare Tunnel（没有公网 IP）

绝大多数家庭宽带 / 国内手机网络没有真公网 IPv4。[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 是反向隧道：你的电脑出站连 Cloudflare，得到一个 HTTPS URL，手机用任意浏览器访问就行，**手机端不用装 app**，免费档够个人用。

```bash
# 1) 装 cloudflared
#    macOS:   brew install cloudflared
#    Linux:   从 https://github.com/cloudflare/cloudflared/releases 下 .deb / .rpm 装
#    Windows: winget install --id Cloudflare.cloudflared
#             或下载 cloudflared-windows-amd64.exe 改名为 cloudflared.exe 放进 PATH

# 2) 启动 mobile-cc（只监听本机，外部由 cloudflared 进来）
uv run python -m mobile_cc --port 8788 --host 127.0.0.1

# 3) 另开终端，起 tunnel
cloudflared tunnel --url http://127.0.0.1:8788
```

终端打出 `https://random-words-xxxx.trycloudflare.com`，**这个 URL 就是手机要访问的地址**，输 API key 登录。

想要稳定的自有域名（不让随机域名每次变）：

```bash
cloudflared tunnel login                # 浏览器扫码授权
cloudflared tunnel create mobile-cc
cloudflared tunnel route dns mobile-cc cc.example.com
cloudflared tunnel run mobile-cc        # 后续每次启动用这个
```

担心 URL 泄露？在 Cloudflare 后台开 Zero Trust Access，加一层 Google / GitHub / 邮件 OTP 验证。

---

## C. 公网 IP + TLS

只在服务器真的有公网 IP 时用。两种方法二选一：

### C1. Caddy 反代（推荐，自动签 Let's Encrypt）

```bash
# 0) 装 Caddy
#    macOS:   brew install caddy
#    Linux:   apt / yum 安装包：https://caddyserver.com/docs/install
#    Windows: winget install CaddyServer.Caddy 或下 Windows 二进制

# 1) mobile-cc 只监听本机，被 Caddy 代过来
uv run python -m mobile_cc --port 8788 --host 127.0.0.1

# 2) Caddyfile（Linux 默认 /etc/caddy/Caddyfile；macOS Homebrew 默认 /opt/homebrew/etc/Caddyfile）
cc.example.com {
    reverse_proxy 127.0.0.1:8788 {
        flush_interval -1   # 关闭缓冲，保证 SSE 实时
    }
}

# 3) 重载 Caddy（首次会自动签证书，DNS A 记录要先指过来）
#    Linux systemd:   sudo systemctl reload caddy
#    macOS brew:      brew services restart caddy
#    Windows:         前台跑用 caddy run；服务化看 nssm / Windows Service
```

手机访问 `https://cc.example.com`。

### C2. mobile-cc 直接挂证书（不想装 Caddy）

主要面向 Linux 服务器。macOS 也可，Windows 上 certbot 不太顺，建议走 C1 或 B。

```bash
# 1) certbot 拿证书（standalone 模式占用 80）
#    Linux:  apt install certbot 或 snap install --classic certbot
#    macOS:  brew install certbot
sudo certbot certonly --standalone -d cc.example.com

# 2) 启动时挂证书 + 8443（443 要 root，8443 任意用户可绑）
uv run python -m mobile_cc \
  --ssl-certfile /etc/letsencrypt/live/cc.example.com/fullchain.pem \
  --ssl-keyfile  /etc/letsencrypt/live/cc.example.com/privkey.pem \
  --port 8443
```

手机访问 `https://cc.example.com:8443`。证书续期记得在 certbot 的 deploy hook 里重启 mobile-cc，uvicorn 不会热加载证书。

### C3. 自签证书（临时调试 / 内网）

需要 `openssl`：macOS / Linux 一般自带；Windows 装 Git for Windows 或 `winget install ShiningLight.OpenSSL` 后 PATH 里就有。

```bash
mkdir -p certs && cd certs
openssl req -x509 -newkey rsa:4096 -keyout self.key -out self.crt \
  -days 365 -nodes -subj "/CN=cc.local"
cd ..
uv run python -m mobile_cc --ssl-certfile certs/self.crt --ssl-keyfile certs/self.key
```

手机会警告「证书不受信任」，点继续访问；至少 API key 不再明文。

---

## 配置

`config.toml` 全部字段：

```toml
host = "0.0.0.0"        # bind 地址；本地测试用 127.0.0.1
port = 8788

# TLS（用法 C2 / C3 才填；走 Caddy 或 Cloudflare 都不用填）
# ssl_certfile = "/etc/letsencrypt/live/.../fullchain.pem"
# ssl_keyfile  = "/etc/letsencrypt/live/.../privkey.pem"

# claude 可执行路径（默认从 PATH 自动找）
# claude_bin = "/usr/local/bin/claude"

# 「新建会话」下拉里出现的工作目录列表
[[allowed_dirs]]
name = "项目甲"
path = "/path/to/repo"

[[allowed_dirs]]
name = "项目乙"
path = "/another/path"
```

命令行参数会覆盖配置：`--host` `--port` `--ssl-certfile` `--ssl-keyfile`。

## 权限模式

每条消息发送前，composer 右下角的 chip 决定本次的权限模式（也持久化为会话默认）：

| 模式 | 行为 |
|---|---|
| **编辑前先问**（default） | 每次工具调用弹卡片让你 allow / 允许本会话 / 拒绝 / 打断 |
| **自动接受编辑**（acceptEdits） | Edit / Write / MultiEdit / NotebookEdit 自动放行；Bash 等仍弹 |
| **计划模式**（plan） | 模型只能写计划文件，调 ExitPlanMode 后弹「批准 / 继续规划」卡片 |
| **全部允许**（bypassPermissions） | 等同 `--dangerously-skip-permissions`，所有工具不询问。仅自己沙箱用 |

特殊处理：`AskUserQuestion` 永远弹问答卡片；`ExitPlanMode` 永远弹计划审批；`TodoWrite` / `TaskStop` / `EnterPlanMode` / `TaskOutput` / `CronList` 自动放行不打扰。

## 安全约束（已经在代码里）

- API key 文件 chmod 600，只有当前用户可读
- `secrets.compare_digest` 等时比较，防侧信道
- 失败鉴权 rate-limit：单 IP 60 秒内 20 次错就 429
- `X-API-Key` 走 header 而不是 query，不进 access log URL 字段
- 文件预览路径在 working_dir 边界内，`../../../etc/passwd` 403
- 新会话只能从 `allowed_dirs` 白名单挑目录

没做的：key 轮换 UI（换 key 就 `rm .api-key && 重启`）、多用户、审计日志落盘、工具沙箱（claude 的 Bash 拿到的就是当前 uid 的全部权限）。

## 开发模式

```bash
# 终端 1：后端 hot reload
uv run python -m mobile_cc --port 8788 --host 127.0.0.1 --reload

# 终端 2：前端 Vite HMR
cd web && npm run dev
# 浏览器 http://localhost:5173 — Vite 把 /api/* 反代到 8788
```

## 项目结构

```
mobile-cc/
├── src/mobile_cc/
│   ├── server.py          # FastAPI app 工厂
│   ├── auth.py            # API key 中间件 + 失败 rate-limit
│   ├── config.py          # config.toml 解析（host/port/tls/allowed_dirs）
│   ├── claude_proc.py     # claude 子进程 + NDJSON ↔ 前端 SSE 翻译
│   ├── permissions.py     # 权限 broker：pending + 会话 allowlist + 自动放行
│   ├── sessions.py        # 直接读 ~/.claude/projects/<slug>/<uuid>.jsonl
│   ├── completions.py     # / 联想（claude init 探测）+ @ 联想（os.walk）
│   └── routes/            # FastAPI 路由
├── scripts/
│   └── permission-hook.py # claude PreToolUse 钩子：POST + long-poll
└── web/
    └── src/               # React 19 + Vite + Tailwind v4 + react-markdown
```

会话数据不另存。Claude Code 自己写在 `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`，本项目读写都基于这个。

## 端到端验证

启动后：

1. `curl http://127.0.0.1:8788/api/health` → `{"ok": true}`
2. 浏览器输 API key 进主界面
3. 新建会话 → 选目录与权限模式 → 发「你好」→ 看到 markdown 流式打字
4. 输入 `/` → 弹 slash + skill 列表
5. 输入 `@` → 弹工作目录文件列表
6. 让 claude 编辑文件 → tool_use 卡片渲染成 unified diff
7. 在文件路径上点击 → FileViewer 打开预览
8. 刷新页面 → 历史会话仍在左侧
9. 故意输错 API key 多次 → 第 21 次起 429 一分钟
