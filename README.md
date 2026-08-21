# DSH Doctor for Windows

`dsh-doctor-windows` is an unofficial, Windows-first startup diagnostic for DeepSeek Harness (DSH). It is read-only with respect to DSH and system configuration, and it sends no telemetry.

## What it checks

The standalone `dsh-doctor` CLI inspects command resolution, supported Node.js versions, DSH_HOME reachability, selected profile manifests, Cordis patches, and direct package links without loading target plugins. Its Cordis plugin provides the same sanitized findings in a recovered DSH session.

The report is diagnostic evidence, not an exhaustive diagnosis. Representative accepted failure examples are:

| Check ID | Meaning |
| --- | --- |
| `command.dsh.missing` | No usable DSH command. |
| `runtime.node.unsupported` | Unsupported Node.js version. |
| `runtime.dsh.shim-target` | Stale npm shim target. |
| `windows.dsh-home.readable` | Unreadable Harness home. |
| `profile.manifest.parse` | Invalid profile manifest. |
| `windows.link.broken` | Broken direct package link or junction. |
| `profile.patch.empty` | Empty or comments-only Cordis patch. |

## Install

Install from npm:

```powershell
npm install -g dsh-doctor-windows
```

Or install a packed tarball:

```powershell
npm install -g .\dsh-doctor-windows-0.1.0.tgz
```

Direct installation from a GitHub source checkout is unsupported. The package intentionally has no `prepare` script; use npm or a packed tarball.

## CLI

```powershell
dsh-doctor
dsh-doctor --profile web
dsh-doctor --profile web --format markdown --output .\dsh-doctor-report.md
dsh-doctor --profile web --format json --no-color
```

Supported options are `--profile`, `--dsh-home`, `--format terminal|markdown|json`, `--output`, `--no-color`, `--verbose`, `--version`, and `--help`. Without `--output`, the CLI writes only to the terminal.

## Cordis plugin

After DSH can boot, add the installed package to a profile:

```powershell
dsh plugin --profile web add dsh-doctor-windows
```

The bundle adds the `dsh_doctor` tool. It returns a sanitized report to the active session and cannot write report files.

## Report and exit codes

Terminal and Markdown reports summarize findings and manual remediation. JSON reports include `schemaVersion` and stable `checkId` values for automation. Exit code `0` means no blocker, `1` means at least one blocker, and `2` means invalid arguments or doctor initialization failed.

## Privacy

The doctor performs no network request, telemetry, or report upload, and does not execute a discovered DSH shim. It does not read `.credentials.yaml` or `.env` contents. Reports redact known homes, DSH_HOME, temporary paths, URL credentials, credential-like values, authorization forms, and high-entropy captured values. Redaction reduces, but cannot eliminate, disclosure risk; review a local report before sharing it.

## Compatibility

Version 1 supports Windows 10 and Windows 11 with PowerShell 5.1 or PowerShell 7, Node.js `^22.19.0 || >=24.0.0`, and a DSH command on `PATH`. The Cordis bundle smoke is verified against `@deepseek-ai/dsh@0.1.0-rc.8`.

## Limitations

Alias and shim selection can differ between shells. Symbolic links and junctions can depend on Windows permissions and filesystem behavior. Profile and bundle formats are pre-release DSH inputs that may change. Version 1 does not support macOS or Linux, automatic repair, plugin-installation automation, telemetry or upload, or a GUI.

## Development

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm pack
```

The packed artifact is the supported test and release input; do not rely on a source checkout behaving like an installed package.

## Release

Maintainers publish only after `pnpm run check` passes. npm publishing requires the maintainer's local two-factor authentication approval; never place a one-time code or access token in source control, logs, or chat.

```powershell
npm publish --access public --registry=https://registry.npmjs.org --otp=123456
npm view dsh-doctor-windows version dist-tags --json --registry=https://registry.npmjs.org
```

Replace `123456` with the current local authenticator code. After publishing, install the registry package into a clean temporary project and confirm that `dsh-doctor --version` works before announcing the release.

## Uninstall

Remove the Cordis bundle from each profile that uses it, then remove the npm package:

```powershell
dsh plugin --profile web remove dsh-doctor-windows
npm uninstall -g dsh-doctor-windows
```
