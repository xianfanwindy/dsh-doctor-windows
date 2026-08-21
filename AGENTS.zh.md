# AGENTS.md（中文）

[English version](AGENTS.md)

## 范围

`dsh-doctor-windows` 是 DeepSeek Harness 的非官方、Windows-first、只读启动诊断工具。

## 仓库结构

- `src/` 包含 CLI、报告模型与渲染器、Cordis plugin、系统适配器和各项检查。
- `tests/` 覆盖源码行为与打包后的 package 安装。
- `cordis.patch.yml` 注册发布后的 Cordis plugin。
- `README.md` 与 `README.zh.md` 分别是公开的英文和中文指南。

## 安全规则

- 除非用户明确指定输出文件，doctor 不得修改 DSH profile、系统配置或报告目标。
- 默认诊断不得执行发现到的 DSH shim，也不得加载被检查的 plugin。
- 所有模型可见或持久化的报告必须完成脱敏；不得加入 telemetry、上传，或读取凭据文件内容。
- 命令发现和打包 package smoke 必须保持 Windows PowerShell 5.1 与 PowerShell 7 的覆盖。

## 开发与发布

- 发布或声称发布有效前，运行 `pnpm run check`。
- npm package 仅发布 `lib/`、`cordis.patch.yml`、两份 README 和 `LICENSE`；应验证打包产物，而非依赖 source checkout。
- 发布后使用 `npm view dsh-doctor-windows version dist-tags --json` 与干净的 `npm install` 验证版本。
- npm 发布需要维护者在本机完成 2FA；不得将 OTP 或 access token 写入仓库、日志或聊天记录。

## 文档与 Git

- `README.md` 与 `README.zh.md` 的结构和行为声明必须同步；中文 README 使用中文标题，专业名称保留 English。
- 只暂存目标路径；不要提交生成的 `lib/`、`coverage/` 或历史 `dist/` 产物。
- 验证并完成审查后，将改动推送到 `origin/main`。
