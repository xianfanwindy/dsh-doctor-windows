# AGENTS.md

[中文版本](AGENTS.zh.md)

## Scope

`dsh-doctor-windows` is an unofficial, Windows-first, read-only startup diagnostic for DeepSeek Harness.

## Repository map

- `src/` contains the CLI, report model and renderers, Cordis plugin, system adapter, and checks.
- `tests/` covers source behavior and packed-package installation.
- `cordis.patch.yml` registers the published Cordis plugin.
- `README.md` and `README.zh.md` are the public English and Chinese guides.

## Safety rules

- The doctor must not alter DSH profiles, system configuration, or report destinations unless the user explicitly requests an output file.
- Default diagnosis must not execute a discovered DSH shim or load inspected plugins.
- Keep every model-visible or persisted report redacted. Do not add telemetry, uploads, or reads of credential-file contents.
- Preserve Windows PowerShell 5.1 and PowerShell 7 coverage for command discovery and packed-package smoke tests.

## Development and release

- Run `pnpm run check` before publishing or claiming a release is valid.
- The npm package ships only `lib/`, `cordis.patch.yml`, both READMEs, and `LICENSE`; validate the packed artifact rather than a source checkout.
- Verify a published version with `npm view dsh-doctor-windows version dist-tags --json` and a clean `npm install` before announcing it.
- npm publishing requires the maintainer's local 2FA approval. Never put an OTP or access token in the repository, logs, or chat.

## Documentation and Git

- Keep `README.md` and `README.zh.md` aligned in structure and behavior claims; the Chinese README uses Chinese headings while technical names remain English.
- Stage only intended paths. Keep generated `lib/`, `coverage/`, and legacy `dist/` artifacts out of commits.
- Push review-clean changes to `origin/main` after validation.
