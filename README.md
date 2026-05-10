# mobile-cc

给命令行版 Claude Code 套一个网页（手机优先）壳。后端是 FastAPI，启动时 spawn `claude` 子进程并把流式输出搬到浏览器，浏览器侧呈现 markdown / 工具调用 / 思考过程，并且支持 `/` 联想 skills、`@` 联想文件、查看历史会话、断点续传。

## 快速开始

前置：本机已安装 Claude Code（`claude` 在 PATH 中），Python 3.12+，Node 20+，[uv](https://docs.astral.sh/uv/)。

```bash
# 克隆/进入项目
cd mobile-cc

# 后端依赖
uv sync

# 前端依赖与构建
cd web && npm install && npm run build && cd ..

# 启动（端口可改）
uv run python -m mobile_cc --port 8788
```

首次启动会在项目根生成 `.api-key` 并把它打印到终端。把这串记下来，浏览器首次访问时要填。

把端口转发到外网（`ssh -R`、frp、Tailscale Funnel 等）后，手机浏览器打开对应地址，输入 API key 即可使用。

## 配置

复制 `config.example.toml` 为 `config.toml` 编辑：

```toml
host = "0.0.0.0"
port = 8788

[[allowed_dirs]]
name = "项目甲"
path = "/path/to/repo"

[[allowed_dirs]]
name = "项目乙"
path = "/another/path"
```

`allowed_dirs` 里的每一项都会在新建会话时出现在下拉里。Claude 启动时 cwd 就设到所选目录，`@` 联想也从这里开始。**安全约束**：用户不能在 web 上随便填路径，只能从这个白名单里选。

## 开发模式

后端和前端分开跑（前端走 Vite HMR）：

```bash
# 终端 1：后端
uv run python -m mobile_cc --port 8788 --reload

# 终端 2：前端
cd web && npm run dev
# 浏览器打开 http://localhost:5173 （Vite 把 /api/* 反代到 8788）
```

## 项目结构

```
mobile-cc/
├── src/mobile_cc/
│   ├── server.py          # FastAPI app 工厂
│   ├── auth.py            # API key 生成 + X-API-Key 中间件
│   ├── config.py          # config.toml 解析
│   ├── claude_proc.py     # claude 子进程 + NDJSON ↔ 前端事件翻译
│   ├── sessions.py        # 直接读 ~/.claude/projects/<slug>/<uuid>.jsonl
│   ├── completions.py     # / 联想（探测 init）+ @ 联想（os.walk + .gitignore）
│   └── routes/            # FastAPI 路由
└── web/
    └── src/               # React + Vite + Tailwind v4 + react-markdown
```

## 数据存储

不另存一份会话数据。Claude Code 自己写在 `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`，本项目读写都基于这个。退出登录或换机器，只要 `~/.claude/projects` 还在，会话历史就还在。

## 已知限制（v1）

- **权限模式**：headless 下 `--permission-mode default` 会把不在 `~/.claude/settings.json` `permissions.allow` 里的工具直接拒掉（非交互不会真的弹 prompt），返回 `is_error: true` 的 `tool_result`。Web 端「弹卡片让人点」的代理是 Phase 7 的事。当前可行的 workaround：把常用工具加到 settings.json 的 allow 列表里。
- **图片输入**：还没接。
- **取消运行**：发送中点「停」会终止当前 turn，但 Claude 已经产生的中间结果会留在 transcript。
- **多用户**：单 API key，单租户假设。

## 端到端验证清单

启动服务器后：

1. `curl http://127.0.0.1:8788/api/health` → `{"ok": true}`
2. 浏览器访问 `http://127.0.0.1:8788/`，进 API key 框 → 输入正确 key 进主界面
3. 「+ 新建」→ 选目录 → 输入「你好」→ 看到 markdown 流式打字
4. 输入 `/` → 弹 slash + skill 列表，能模糊筛
5. 输入 `@` → 弹工作目录文件列表
6. 刷新页面 → 历史会话仍在左侧，点开能续接
7. 移动端宽度（DevTools 模拟）→ 抽屉、键盘适配正常，中文输入法不误触发斜杠菜单
