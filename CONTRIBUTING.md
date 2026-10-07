# Contributing

Thanks for your interest in this extension! Issues and Pull Requests are both welcome.

## Reporting issues

Open an issue at [Issues](https://github.com/sh-u-x-in/ros2-dev-extension/issues) and, where possible, include:

1. Your ROS 2 distribution and install method (e.g. Humble / deb or pixi) and operating system;
2. Reproduction steps and expected vs. actual behavior;
3. Relevant logs from the "ROS 2" output channel (the level picker in the top-right can be switched to Debug);
4. If status-page related: the behavior before/after starting and stopping the helper.

## Local development

```bash
npm install          # install dependencies
npm run dev-build    # tsc + webpack (development build)
npm test             # full test suite (vscode-test-electron host)
npm run test-compile # tsc only
npm run package      # production bundle (same as vscode:prepublish)
```

Requirements: Node.js (>= 20) and npm; running the tests the first time needs network access to download the VS Code test host.

### Code layout

Every directory under `src/` has a README.md (purpose / file table / boundaries / change log) — **read the matching README before changing code**. `设计/` (design) and `知识/` (knowledge) hold design drafts and measured facts, which are the source of truth for many criteria.

### Conventions

- Each module README's change-log table is updated alongside code changes (times to the minute);
- Commit messages are written in Chinese with the format `类型(范围): 说明` (type(scope): description);
- User-facing strings are English-source via `vscode.l10n` with a zh-cn bundle under `l10n/` (see the i18n convention in the module READMEs).

## License

By submitting a contribution you agree to release it under the [MIT License](LICENSE).
