# agent-grep

Interactive grep across your Claude Code and Codex CLI session history.

Source: https://github.com/Evgastap/agent-grep

## Install

```sh
npm install -g agent-grep
```

Ships a bundled `ripgrep` (via `@vscode/ripgrep`). Falls back to system `rg`, then `grep`.

## Use

```sh
agent-grep                     # launch TUI
agent-grep "firebase auth"     # TUI, prefilled
agent-grep -P "pnpm"           # force print mode
agent-grep --json "pnpm" | jq  # pipe JSON
```

Searches `~/.claude` and `~/.codex` by default. `Enter` on a result `cd`s into the project and resumes the session via `claude --resume` or `codex resume`.

## TUI keys

| Key      | Action                                            |
| -------- | ------------------------------------------------- |
| type…    | Live search                                       |
| ↑ / ↓    | Navigate results                                  |
| `Enter`  | Resume the session in its project dir             |
| `Tab`    | Cycle role filter (all → user → assistant → tool) |
| `Ctrl+B` | Cycle source (both → claude-code → codex)        |
| `Ctrl+P` | Toggle project filter (all / cwd)                 |
| `Ctrl+D` | Toggle `--dangerously-skip-permissions`           |
| `Esc`    | Quit                                              |

`agent-grep --help` for all flags.
