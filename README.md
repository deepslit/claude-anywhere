# mobile-cc

给命令行版 Claude Code 套一个网页（手机优先）壳。后端是 FastAPI，启动时 spawn `claude` 子进程并把 NDJSON 流搬到浏览器；前端是 React + Tailwind 的 chat UI，支持 markdown、工具调用 / 思考过程卡片、`/` 联想 skills、`@` 联想文件、文件预览、多会话续接、权限卡片（含 AskUserQuestion 问答和 ExitPlanMode 计划审批）。

## 快速开始

前置：本机已安装 [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code)（`claude` 在 PATH 中），Python 3.12+，Node 20+，[uv](https://docs.astral.sh/uv/)。

```bash
cd mobile-cc
uv sync
cd web && npm install && npm run build && cd ..

# 启动
uv run python -m mobile_cc --port 8788
```

首次启动会在项目根生成 `.api-key` 并把它打印到终端。这串就是浏览器登录用的密钥。

本机访问：浏览器 `http://127.0.0.1:8788/`。**远程 / 手机访问需要先看 [Security](#security) 章节配置 TLS**——明文 HTTP 把 API key 直接暴露在网络上。

## 配置

复制 `config.example.toml` 为 `config.toml` 编辑：

```toml
host = "0.0.0.0"
port = 8788

# 走 HTTPS 时填这两个；空着就裸 HTTP
ssl_certfile = "/etc/letsencrypt/live/cc.example.com/fullchain.pem"
ssl_keyfile  = "/etc/letsencrypt/live/cc.example.com/privkey.pem"

[[allowed_dirs]]
name = "项目甲"
path = "/path/to/repo"

[[allowed_dirs]]
name = "项目乙"
path = "/another/path"
```

`allowed_dirs` 每一项都会在「新建会话」下拉里出现。Claude 启动时 cwd 就设到所选目录，`@` 联想也从这里开始。**用户不能在 web 上随便填路径，只能从这个白名单里选。**

## Security

威胁模型先讲清楚：

- API key 等于 shell。哪怕权限模式是 default，攻击者也是「用户」本人——他可以让 claude 调 Bash 然后自己点 allow。
- 默认 `bypassPermissions` 模式更激进，所有工具直接放行不弹卡片。
- 明文 HTTP 上传 `X-API-Key` header → 抓包就拿到 key。

部署假设：**单用户、自己的服务器、自己对自己负责**。先判断有没有公网 IP，再选 recipe：

| 场景 | 推荐 |
|---|---|
| **没有公网 IP**（家用 / CGNAT） | Cloudflare Tunnel |
| 有公网 IP 的服务器 | Caddy 反代自动 HTTPS（推荐）或 mobile-cc 直接挂证书 |
| 临时 / 内网调试 | 自签证书 |

### 没有公网 IP → Cloudflare Tunnel（最推荐）

绝大多数家庭宽带和国内手机网络拿不到真公网 IPv4，路由器端口转发不通。[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 是反向隧道：你的电脑出站连 Cloudflare，得到一个 HTTPS URL，手机用任意浏览器访问就行，**手机端不用装 app**，免费档够个人用。

```bash
# 1) 装 cloudflared
#    macOS:  brew install cloudflared
#    Linux:  下载官方 .deb / .rpm（https://github.com/cloudflare/cloudflared/releases）

# 2) 一次性 quick tunnel（拿到随机域名）
cloudflared tunnel --url http://127.0.0.1:8788
# 终端打出 https://random-words-xxxx.trycloudflare.com
# 手机浏览器直接用这个 URL，输 API key 登录

# 3)（可选）想要稳定 URL + 自有域名（不让随机域名每次变）
cloudflared tunnel login          # 浏览器扫码授权
cloudflared tunnel create mobile-cc
cloudflared tunnel route dns mobile-cc cc.example.com
# 然后在 ~/.cloudflared/config.yml 里配 ingress 指向 127.0.0.1:8788
cloudflared tunnel run mobile-cc
```

URL 是 HTTPS，流量从你的电脑出站，不需要公网 IP / 端口转发 / 路由器配置。

**注意**：Cloudflare 看得到你的 HTTPS 元数据（域名、时间、大小）但看不到 API key 和聊天内容（key 在 header 里加密传到 mobile-cc 才解密）。如果担心：可以在 Cloudflare Zero Trust 后台开 Cloudflare Access，加一层 SSO（Google / GitHub / 邮件验证）。

### 有公网 IP → Caddy 反向代理（自动 Let's Encrypt）

```bash
# 1) 让 mobile-cc 只监听 localhost（被 Caddy 代）
echo 'host = "127.0.0.1"' >> config.toml

# 2) /etc/caddy/Caddyfile
cc.example.com {
    reverse_proxy 127.0.0.1:8788 {
        flush_interval -1   # 关闭缓冲，保证 SSE 实时
    }
}

# 3) 起 Caddy（首次会自动签证书，DNS A 记录指过来）
sudo systemctl reload caddy
```

手机直接访问 `https://cc.example.com`。Caddy 自动续期，不用管。

### 有公网 IP → mobile-cc 自带 TLS（certbot 拿证书）

适合不想装 Caddy 的场景。用 8443 避免 root（443 需要 root 或 `setcap CAP_NET_BIND_SERVICE`）：

```bash
# 1) 用 certbot 拿证书（DNS A 记录指过来，80 端口空闲）
sudo certbot certonly --standalone -d cc.example.com

# 2) 启动时挂证书
uv run python -m mobile_cc \
  --ssl-certfile /etc/letsencrypt/live/cc.example.com/fullchain.pem \
  --ssl-keyfile  /etc/letsencrypt/live/cc.example.com/privkey.pem \
  --port 8443
```

手机访问 `https://cc.example.com:8443`。certbot 续期记得在 deploy hook 里 `systemctl restart mobile-cc` 一下，否则新证书要等下次重启才生效。

### 临时 / 内网：自签证书

```bash
mkdir -p certs && cd certs
openssl req -x509 -newkey rsa:4096 -keyout self.key -out self.crt \
  -days 365 -nodes -subj "/CN=cc.local"
cd ..

uv run python -m mobile_cc --ssl-certfile certs/self.crt --ssl-keyfile certs/self.key
```

手机浏览器会警告「证书不受信任」，点继续访问；API key 至少不再明文。

### 其他安全约束（已经在代码里）

- **API key 文件 chmod 600**，只有当前用户可读
- **`secrets.compare_digest` 等时比较**，防侧信道
- **失败鉴权 rate-limit**：单 IP 60 秒内 20 次失败就 429 一段时间（防扫端口刷日志）
- **`X-API-Key` 走 header 而不是 query string**：不会出现在 access log 的 URL 字段
- **文件预览接口受 working_dir 边界约束**：`../../../etc/passwd` 这种路径 403
- **新会话只能从 `allowed_dirs` 白名单挑目录**

### 我没做的

- **Key 轮换 UI**：要换 key 就 `rm .api-key && 重启`，新 key 会打印到终端
- **多用户**：单 key 单租户假设
- **审计日志持久化**：uvicorn 的访问日志在终端，没落盘
- **更细的工具沙箱**：claude 的 Bash 拿到的就是当前 uid 的全部权限

## 权限模式

每条消息发送前，composer 右下角的 chip 决定本次的权限模式（也持久化为会话默认）：

| 模式 | 行为 |
|---|---|
| **编辑前先问**（default） | 每次工具调用弹卡片让你 allow / 允许本会话/拒绝/打断 |
| **自动接受编辑**（acceptEdits） | Edit/Write/MultiEdit/NotebookEdit 自动放行；Bash 等仍弹 |
| **计划模式**（plan） | 模型只能写计划文件，调 ExitPlanMode 后弹「批准 / 继续规划」卡片 |
| **全部允许**（bypassPermissions） | 等同 `--dangerously-skip-permissions`，所有工具不询问。仅自己沙箱用 |

特殊处理：`AskUserQuestion` 永远弹问答卡片（不会被「允许本会话」短路）；`ExitPlanMode` 永远弹计划审批卡片；`TodoWrite` / `TaskStop` / `EnterPlanMode` / `TaskOutput` / `CronList` 自动放行不打扰。

## 开发模式

后端和前端分开跑（前端走 Vite HMR）：

```bash
# 终端 1：后端
uv run python -m mobile_cc --port 8788 --reload

# 终端 2：前端
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
│   └── routes/
│       ├── chat.py        # POST /messages → SSE
│       ├── sessions.py    # 会话 CRUD
│       ├── permissions.py # 权限决定（hook 长轮询 + 用户提交）
│       ├── completions.py # 联想
│       ├── files.py       # 文件预览（限定 working_dir 内）
│       └── meta.py        # health, dirs
├── scripts/
│   └── permission-hook.py # claude PreToolUse 钩子：POST + long-poll
└── web/
    └── src/               # React 19 + Vite + Tailwind v4 + react-markdown
```

## 数据存储

不另存一份。Claude Code 自己写在 `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`，本项目读写都基于这个。退出登录或换机器，只要 `~/.claude/projects` 还在，会话历史就还在。

## 端到端验证清单

启动服务器后：

1. `curl http://127.0.0.1:8788/api/health` → `{"ok": true}`
2. 浏览器访问主页，输入 API key 进主界面
3. 新建会话 → 选目录与权限模式 → 发「你好」→ 看到 markdown 流式打字
4. 输入 `/` → 弹 slash + skill 列表
5. 输入 `@` → 弹工作目录文件列表
6. 让 claude 写一个文件 → 看到权限卡片或自动放行（依模式）
7. 让 claude 编辑文件 → tool_use 卡片渲染成 unified diff
8. 在文件路径上点击 → FileViewer 打开预览
9. 刷新页面 → 历史会话仍在左侧
10. 故意输错 API key 多次 → 第 21 次起 429 一分钟
