# AI Video Studio

本仓库是 `AI Video Studio` 的 V0.2 可运行基线，当前实现两条本地项目链路：

```text
Idea → Python JSONL Worker → Canonical Project → SQLite → React 编辑界面
Script Text / TXT / MD / DOCX / PDF → Script Workflow → Canonical Project
```

桌面端支持选择项目根目录、复制原始剧本到项目 `source/`、重新打开已有项目，并将剧情、角色、场景、场次、镜头和任务历史持久化到项目 SQLite。

仓库同时包含正在建设的云端支撑平台：

- `apps/server`：NestJS 模块化单体，使用 MySQL 5.7+，提供管理员鉴权、RBAC、版本化客户端配置、AI 供应商目录、任务最小元数据、账务/微信支付数据模型和审计。
- `apps/admin-web`：Next.js 响应式运营管理后台。
- 服务端已提供用户注册登录、积分购买和 AI 任务创建/查询中转；不保存任务图片、音频、视频、提示词或完整结果正文。

## 本地开发

生产环境部署管理后台和服务端 API，请阅读 [部署与 CI/CD 手册](docs/deployment.md)。仓库提供 Docker 镜像、宝塔 Nginx 反向代理示例和 GitHub Actions 工作流；自动上线默认关闭。

前端浏览器演示模式（不要求 Rust）：

```powershell
npm.cmd install
npm.cmd run dev
```

Python Worker：

```powershell
python python-engine/main.py
```

输入一行 JSONL 请求后，Worker 会输出进度事件和最终结果。运行测试：

```powershell
npm.cmd run test:python
npm.cmd run typecheck
npm.cmd run build
```

服务端和管理后台：

```powershell
# 按 apps/server/.env.example 配置运行时环境变量
npm.cmd run db:migrate
npm.cmd run db:seed-config
npm.cmd run dev:server
npm.cmd run dev:admin
```

管理后台默认地址为 `http://localhost:3200`，服务端健康检查为 `http://localhost:3101/api/v1/health`。数据库密码、JWT 密钥、微信商户密钥和供应商密钥均不得写入仓库。

完整桌面模式还需要安装 Rust toolchain，然后运行：

```powershell
npm.cmd run tauri:dev
```

如果当前终端不在仓库目录，可从任意位置运行：

```powershell
npm.cmd --prefix C:\code\AIVideoStudio run tauri:dev
```

浏览器模式使用内存/LocalStorage 适配器，便于在未安装 Rust 的机器上验证产品流程；Tauri 模式使用本地项目目录、SQLite 和 Python Worker。
