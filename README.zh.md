# Windows 版 DSH Doctor

`dsh-doctor-windows` 是 DeepSeek Harness（DSH）的非官方、Windows-first 启动诊断工具。它对 DSH 和系统配置保持只读，且不发送 telemetry。

## What it checks

独立的 `dsh-doctor` CLI 会检查命令解析、受支持的 Node.js 版本、DSH_HOME 可访问性、所选 profile manifest、Cordis patch 与直接 package link，并且不会加载目标 plugin。其 Cordis plugin 会在恢复后的 DSH session 中提供相同的已脱敏 finding。

报告提供的是诊断证据，并非穷尽性诊断。以下是具有代表性的已接受失败示例：

| Check ID | 含义 |
| --- | --- |
| `command.dsh.missing` | 没有可用的 DSH command。 |
| `runtime.node.unsupported` | Node.js 版本不受支持。 |
| `runtime.dsh.shim-target` | npm shim target 已过期。 |
| `windows.dsh-home.readable` | Harness home 不可读。 |
| `profile.manifest.parse` | profile manifest 无效。 |
| `windows.link.broken` | 直接 package link 或 junction 已损坏。 |
| `profile.patch.empty` | Cordis patch 为空或只有注释。 |

## Install

从 npm 安装：

```powershell
npm install -g dsh-doctor-windows
```

或安装 packed tarball：

```powershell
npm install -g .\dsh-doctor-windows-0.1.0.tgz
```

不支持从 GitHub source checkout 直接安装。该 package 有意不提供 `prepare` script；请使用 npm 或 packed tarball。

## CLI

```powershell
dsh-doctor
dsh-doctor --profile web
dsh-doctor --profile web --format markdown --output .\dsh-doctor-report.md
dsh-doctor --profile web --format json --no-color
```

支持的 option 为 `--profile`、`--dsh-home`、`--format terminal|markdown|json`、`--output`、`--no-color`、`--verbose`、`--version` 和 `--help`。未指定 `--output` 时，CLI 只写入 terminal。

## Cordis plugin

DSH 能够启动后，将已安装的 package 添加到 profile：

```powershell
dsh plugin --profile web add dsh-doctor-windows
```

该 bundle 会添加 `dsh_doctor` tool。它向当前 session 返回已脱敏 report，且不能写入 report file。

## Report and exit codes

Terminal 和 Markdown report 会汇总 finding 与手动 remediation。JSON report 包含供自动化使用的 `schemaVersion` 与稳定 `checkId`。退出码 `0` 表示没有 blocker，`1` 表示至少有一个 blocker，`2` 表示参数无效或 doctor 初始化失败。

## Privacy

Doctor 不执行 network request、telemetry 或 report upload。它不读取 `.credentials.yaml` 或 `.env` 的内容。报告会脱敏已知 home、DSH_HOME、temporary path、URL credential、credential-like value、authorization form 以及高熵捕获值。脱敏会降低但不能消除泄露风险；分享前请审阅本地 report。

## Compatibility

版本 1 支持 Windows 10 和 Windows 11，PowerShell 5.1 或 PowerShell 7，Node.js `^22.19.0 || >=24.0.0`，以及位于 `PATH` 的 DSH command。Cordis bundle smoke 已针对 `@deepseek-ai/dsh@0.1.0-rc.8` 验证。

## Limitations

Alias 和 shim 的选择可能因 shell 不同而变化。Symbolic link 和 junction 可能受 Windows permission 与 filesystem behavior 影响。Profile 与 bundle format 是可能变化的 pre-release DSH input。版本 1 不支持 macOS 或 Linux、automatic repair、plugin-installation automation、telemetry 或 upload，或 GUI。

## Development

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm pack
```

Packed artifact 才是受支持的测试和 release input；不要依赖 source checkout 的行为等同于已安装 package。

## Uninstall

从每个使用该 bundle 的 profile 中移除它，然后移除 npm package：

```powershell
dsh plugin --profile web remove dsh-doctor-windows
npm uninstall -g dsh-doctor-windows
```
