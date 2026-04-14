# cc-history

Interactive grep across your Claude Code and Codex CLI session history.

## Install

```sh
npm install -g cc-history
```

Ships a bundled `ripgrep` (via `@vscode/ripgrep`). Falls back to system `rg`, then `grep`.

## Use

```sh
cc-history                     # launch TUI
cc-history "firebase auth"     # TUI, prefilled
cc-history -P "pnpm"           # force print mode
cc-history --json "pnpm" | jq  # pipe JSON
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

`cc-history --help` for all flags.
