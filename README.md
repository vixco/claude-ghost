# claude-ghost

A stealth terminal wrapper around [Claude Code](https://claude.com/claude-code). Launches a real PowerShell session that looks and behaves exactly like a normal shell — until you press **F12**. Then it becomes a Claude prompt. Press F12 again to wipe the screen and go back. Press F12 once more and your previous chat reappears.

Built for people who want to use Claude inside a terminal that does not visually scream "AI is here."

```
PS C:\Users\you> git status
On branch main
nothing to commit, working tree clean
PS C:\Users\you>            ← press F12
>                           ← AI mode (dim '>' prompt, looks like a continuation prompt)
> summarize the last 3 commits in this repo
... Claude responds ...
>                           ← press F12 — screen + scrollback wipe (killswitch)
PS C:\Users\you>            ← back to a clean PowerShell
                            ← press F12 again — your previous chat is replayed
```

## How it works

- Spawns a real `powershell.exe` inside a PTY (via [`node-pty`](https://github.com/microsoft/node-pty)). All shell behavior — prompts, colors, completions, running programs — works because it really is PowerShell.
- Puts your terminal's stdin into raw mode and intercepts keystrokes before they reach the inner shell. **F12** flips between shell mode and AI mode.
- AI mode pipes each prompt (via stdin, to avoid Windows shell argument splitting) to the local `claude` CLI:
  ```
  claude -p --session-id <uuid> --permission-mode bypassPermissions
  ```
  A fixed `--session-id` per ghost run, followed by `--resume <id>` on each subsequent call, gives Claude conversation memory across messages.
- Uses your **existing Claude Code login** — your Claude.ai subscription. No API key needed.
- The AI conversation is buffered in memory and re-rendered every time you re-enter AI mode, so the chat history is visible again after toggling back.
- When you toggle out of AI mode, the visible screen **and** scrollback are wiped — a "killswitch" so nothing AI-shaped lingers on screen.

## Requirements

- Windows 10 / 11
- [Node.js](https://nodejs.org/) 18 or newer (tested with 22)
- [Claude Code](https://claude.com/claude-code) installed and authenticated (`claude` on your PATH)
- **Windows Terminal recommended**. The legacy "Windows PowerShell" blue console (`conhost`) has poor ConPTY and raw-key support, which can break keystroke interception.

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
3. Adds a `claude-ghost` function to your PowerShell `$PROFILE`. The function (not the cmd shim) is what makes F12 actually work — it keeps `node`'s stdin as a real TTY so raw-mode keystroke interception is possible

Restart PowerShell after install, or `. $PROFILE` to reload.

## Usage

```powershell
claude-ghost
```

| Key | Action |
| --- | --- |
| **F12** *or* **Shift+Tab** | Toggle between shell and AI mode. Both are enabled by default — use Shift+Tab if your laptop's Fn key swallows F12. Exiting AI mode wipes the screen + scrollback (killswitch); re-entering replays your prior chat. |
| **Enter** | (AI mode) Send the current line to Claude |
| **Backspace** | (AI mode) Edit the current line |
| **Ctrl+C** | (AI mode) Cancel a running Claude response |
| **Ctrl+D** | (AI mode) Exit AI mode back to shell (no screen wipe) |

Type `exit` in shell mode (or close the terminal) to end the session.

## Configuration

All optional. Set as environment variables before launching `claude-ghost`.

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_GHOST_SHELL` | `powershell.exe` | Shell to spawn inside the PTY (e.g. `pwsh.exe` for PowerShell 7) |
| `CLAUDE_GHOST_TOGGLE_KEYS` | F12 + Shift+Tab (`1b5b32347e,1b5b5a`) | Comma-separated hex sequences of the keys that toggle modes. Override to use any key(s) your terminal emits. |
| `CLAUDE_GHOST_MODEL` | *(unset — uses your Claude Code default)* | Model alias (e.g. `opus`, `sonnet`) passed through to `claude --model` |
| `CLAUDE_GHOST_PERMISSION_MODE` | `bypassPermissions` | Forwarded as `claude --permission-mode`. By default Claude is allowed to do everything without asking — convenient but only safe in directories you trust. Set to `default` for normal prompting, or `acceptEdits` to allow file edits only. |
| `CLAUDE_GHOST_DEBUG_KEYS` | unset | When `1`, prints the hex of every keystroke to stderr instead of doing anything else. Use to discover your terminal's actual toggle byte sequence. |

### Finding your terminal's toggle key

If F12 doesn't work in your terminal (some remote/embedded terminals intercept function keys):

```powershell
$env:CLAUDE_GHOST_DEBUG_KEYS=1
claude-ghost
# press F12, Shift+Tab, or whatever key you want — note its hex
# Ctrl+C to quit, then:
Remove-Item Env:CLAUDE_GHOST_DEBUG_KEYS
$env:CLAUDE_GHOST_TOGGLE_KEYS="<hex>"
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
