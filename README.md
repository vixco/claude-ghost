# claude-ghost

A stealth terminal wrapper around [Claude Code](https://claude.com/claude-code). Launches a real PowerShell session that looks and behaves exactly like a normal shell — until you press a toggle key. Then it becomes a Claude prompt. Press the toggle again to go back. The prior conversation stays on screen when you re-enter.

Built for people who want to use Claude inside a terminal that does not visually scream "AI is here."

```
PS C:\Users\you> git status
On branch main
nothing to commit, working tree clean
PS C:\Users\you>            ← press Shift+Tab
>                           ← AI mode (dim '>' prompt, looks like a continuation prompt)
> summarize the last 3 commits in this repo
... Claude responds ...
>                           ← press Shift+Tab
PS C:\Users\you>            ← back to PowerShell
```

## How it works

- Spawns a real `powershell.exe` inside a PTY (via [`node-pty`](https://github.com/microsoft/node-pty)). All shell behavior — prompts, colors, completions, running programs — works because it really is PowerShell.
- Puts your terminal's stdin into raw mode and intercepts keystrokes before they reach the inner shell. Configured toggle keys (default **Shift+Tab** and **F12**) flip between shell mode and AI mode.
- AI mode forwards each prompt to the local `claude` CLI:
  ```
  claude -p "<your prompt>" --session-id <uuid> --permission-mode <mode>
  ```
  A fixed `--session-id` per ghost run gives Claude conversation memory across messages.
- Uses your **existing Claude Code login** — your Claude.ai subscription. No API key needed.
- The AI conversation is buffered in memory and re-rendered every time you re-enter AI mode, so the chat history is visible again after toggling back.

## Requirements

- Windows 10 / 11
- [Node.js](https://nodejs.org/) 18 or newer (tested with 22)
- [Claude Code](https://claude.com/claude-code) installed and authenticated (`claude` on your PATH)
- **Windows Terminal recommended**. The legacy "Windows PowerShell" blue console (`conhost`) has poor ConPTY and raw-key support; Shift+Tab in particular often doesn't produce a sendable byte there.

## Install

**One-liner** (recommended). Open PowerShell and run:

```powershell
iwr -useb https://raw.githubusercontent.com/PrincNL/claude-ghost/main/install.ps1 | iex
```

Or clone manually:

```powershell
git clone https://github.com/PrincNL/claude-ghost.git
cd claude-ghost
.\install.ps1
```

The installer does three things:
1. `npm install` to fetch `node-pty`
2. Drops a `claude-ghost.cmd` shim into your npm global prefix so it's on PATH
3. Adds a `claude-ghost` function to your PowerShell `$PROFILE`. The function (not the cmd shim) is what makes Shift+Tab actually work — it keeps `node`'s stdin as a real TTY so raw-mode keystroke interception is possible

Restart PowerShell after install, or `. $PROFILE` to reload.

## Usage

```powershell
claude-ghost
```

| Key | Action |
| --- | --- |
| **Shift+Tab** | Toggle between shell and AI mode |
| **F12** | Same — fallback if your terminal doesn't emit Shift+Tab |
| **Enter** | (AI mode) Send the current line to Claude |
| **Backspace** | (AI mode) Edit the current line |
| **Ctrl+C** | (AI mode) Cancel a running Claude response |
| **Ctrl+D** | (AI mode) Exit AI mode back to shell |

Type `exit` in shell mode (or close the terminal) to end the session.

## Configuration

All optional. Set as environment variables before launching `claude-ghost`.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_GHOST_SHELL` | `powershell.exe` | Shell to spawn inside the PTY (e.g. `pwsh.exe` for PowerShell 7) |
| `CLAUDE_GHOST_TOGGLE_KEYS` | Shift+Tab + F12 | Comma-separated hex sequences of the keys that toggle modes (e.g. `1b5b5a,1b5b32347e`) |
| `CLAUDE_GHOST_MODEL` | *(unset — uses your Claude Code default)* | Model alias (e.g. `opus`, `sonnet`) passed through to `claude --model` |
| `CLAUDE_GHOST_PERMISSION_MODE` | `bypassPermissions` | Forwarded as `claude --permission-mode`. By default Claude is allowed to do everything without asking — convenient but only safe in directories you trust. Set to `default` for normal prompting, or `acceptEdits` to allow file edits only. |
| `CLAUDE_GHOST_DEBUG_KEYS` | unset | When `1`, prints the hex of every keystroke to stderr instead of doing anything else. Use to discover your terminal's actual toggle byte sequence. |

### Finding your terminal's toggle key

If neither default toggle works:

```powershell
$env:CLAUDE_GHOST_DEBUG_KEYS=1
claude-ghost
# press Shift+Tab — note the hex
# press whatever key you want as toggle — note the hex
# Ctrl+C to quit, then:
Remove-Item Env:CLAUDE_GHOST_DEBUG_KEYS
$env:CLAUDE_GHOST_TOGGLE_KEYS="<hex1>,<hex2>"
claude-ghost
```

## Caveats

- **Stealth is visual, not forensic.** The wrapper runs `claude` as a child process, which is visible to anyone reading process lists, network traffic, or your shell history. Don't use this where you actually need privacy from technical observers.
- **Permissions are bypassed by default.** `claude` is launched with `--permission-mode bypassPermissions` so it can edit files, run commands, and use any tool without asking. This is required for `-p` mode to be usable (interactive approval prompts don't render). Only run `claude-ghost` in directories you trust, or set `CLAUDE_GHOST_PERMISSION_MODE=default` for normal prompting (you'll see denied tool calls in the output).
- **No streaming partial-message rendering yet.** Output appears as `claude -p` flushes, which is usually whole sentences or larger chunks.
- **Legacy `conhost` is not supported.** Use Windows Terminal.
- **The transcript replay grows unbounded.** Long sessions will redraw a lot of text on each toggle. Restart `claude-ghost` to clear.

## Uninstall

```powershell
# Remove the cmd shim
Remove-Item (Join-Path (npm config get prefix).Trim() 'claude-ghost.cmd')

# Remove the profile block (edit $PROFILE and delete the lines between
# `# >>> claude-ghost >>>` and `# <<< claude-ghost <<<`)
```

## License

MIT
