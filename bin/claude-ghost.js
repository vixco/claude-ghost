#!/usr/bin/env node
/**
 * claude-ghost — stealth wrapper around PowerShell + Claude Code.
 *
 * Behavior:
 *   - Spawns a real PowerShell session inside a PTY. Looks and works exactly
 *     like a normal shell.
 *   - Watches stdin for Shift+Tab (ESC [ Z). On that keystroke, toggles
 *     between "shell" mode (default, passthrough to PowerShell) and "ai"
 *     mode (input goes to Claude Code via `claude -p`).
 *   - AI mode uses your existing Claude Code login (no API key needed).
 *   - One persistent session-id per ghost run so the conversation has memory.
 */

const pty = require('node-pty');
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');

const SHELL = process.env.CLAUDE_GHOST_SHELL || 'powershell.exe';
const SHELL_ARGS = SHELL.toLowerCase().includes('powershell') ? ['-NoLogo'] : [];

// ANSI / control sequences
const SHIFT_TAB = '\x1b[Z';
const F12 = '\x1b[24~';
const CTRL_C = '\x03';
const CTRL_D = '\x04';
const ENTER_CR = '\r';
const ENTER_LF = '\n';
const BACKSPACE = '\x7f';
const BACKSPACE_ALT = '\b';

// Toggle keys: defaults are Shift+Tab and F12. Override with env var
// CLAUDE_GHOST_TOGGLE_KEYS, comma-separated hex strings, e.g. "1b5b5a,1b5b32347e"
const DEFAULT_TOGGLES = [SHIFT_TAB, F12];
const TOGGLE_KEYS = (() => {
  const raw = process.env.CLAUDE_GHOST_TOGGLE_KEYS;
  if (!raw) return DEFAULT_TOGGLES;
  return raw.split(',').map((hex) => Buffer.from(hex.trim(), 'hex').toString('binary'));
})();

const DEBUG_KEYS = process.env.CLAUDE_GHOST_DEBUG_KEYS === '1';

// Visual styling for AI mode — kept ultra-minimal so it doesn't shout "AI"
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const RED = '\x1b[31m';

// Session state
let mode = 'shell';
let aiBuffer = '';        // current line being typed in AI mode
let aiBusy = false;
let aiChild = null;
let aiTranscript = '';    // everything ever shown in AI mode, replayed on re-entry
let aiFirstCall = true;   // first claude invocation creates the session; later calls resume it
const sessionId = crypto.randomUUID();

// Strip terminal-title-setting OSC sequences:
//   ESC ] 0|1|2 ; <title> BEL
//   ESC ] 0|1|2 ; <title> ESC \
// Claude Code sets the title to "claude" via these — we filter them out so
// the terminal window/tab title stays whatever it was.
const TITLE_OSC = /\x1b\][0-2];[^\x07\x1b]*?(?:\x07|\x1b\\)/g;
function stripTitle(s) {
  return s.replace(TITLE_OSC, '');
}

// Write to terminal AND record into the AI transcript so a future toggle
// can replay the whole conversation.
function aiWrite(s) {
  aiTranscript += s;
  process.stdout.write(s);
}

// ---------------------------------------------------------------------------
// PTY: the visible PowerShell
// ---------------------------------------------------------------------------
const ptyProcess = pty.spawn(SHELL, SHELL_ARGS, {
  name: 'xterm-256color',
  cols: process.stdout.columns || 120,
  rows: process.stdout.rows || 30,
  cwd: process.cwd(),
  env: process.env,
});

ptyProcess.onData((data) => {
  // Always relay PTY output. Even in AI mode, the shell may still be emitting
  // (e.g. a long-running command), but in practice the user toggles only at
  // the prompt so this is mostly idle.
  if (mode === 'shell') {
    process.stdout.write(data);
  }
});

ptyProcess.onExit(({ exitCode }) => {
  cleanup();
  process.exit(exitCode || 0);
});

// ---------------------------------------------------------------------------
// stdin: intercept Shift+Tab, forward everything else
// ---------------------------------------------------------------------------
if (!process.stdin.isTTY) {
  process.stderr.write(
    '\r\n[claude-ghost] stdin is not a TTY — toggle keys cannot be intercepted.\r\n' +
    '              Launch via the PowerShell function (run install.ps1 again)\r\n' +
    '              or invoke node directly: node "' + __filename + '"\r\n\r\n'
  );
  process.exit(1);
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

if (DEBUG_KEYS) {
  process.stderr.write('[claude-ghost] DEBUG_KEYS on. Press keys to see hex. Ctrl+C to exit.\r\n');
}

process.stdin.on('data', (data) => {
  if (DEBUG_KEYS) {
    const hex = Buffer.from(data, 'binary').toString('hex');
    process.stderr.write(`[keys] len=${data.length} hex=${hex}\r\n`);
    if (data === '\x03') process.exit(0); // Ctrl-C exits debug mode
    return;
  }

  // Toggle key — checked first, in any mode. Exact match so we don't swallow
  // a toggle byte embedded in a larger paste.
  if (TOGGLE_KEYS.includes(data)) {
    toggleMode();
    return;
  }

  if (mode === 'shell') {
    ptyProcess.write(data);
    return;
  }

  // AI mode — handle inline line editing ourselves
  handleAiInput(data);
});

process.stdout.on('resize', () => {
  try {
    ptyProcess.resize(process.stdout.columns, process.stdout.rows);
  } catch (_) {}
});

// ---------------------------------------------------------------------------
// Mode toggle
// ---------------------------------------------------------------------------
function toggleMode() {
  if (aiBusy) return; // ignore toggles while Claude is streaming a reply

  if (mode === 'shell') {
    mode = 'ai';
    aiBuffer = '';
    process.stdout.write('\r\n');
    if (aiTranscript.length === 0) {
      // First entry into AI mode this session.
      showPrompt();
    } else {
      // Resume: replay the whole prior AI conversation, ending at a fresh
      // prompt that the user can type into.
      process.stdout.write(aiTranscript);
    }
  } else {
    mode = 'shell';
    // Cancel any half-typed prompt.
    aiBuffer = '';
    // Killswitch: wipe scrollback + visible screen + home the cursor so no
    // trace of the AI conversation remains on-screen. Transcript stays in
    // memory and is replayed on the next toggle into AI mode.
    //   \x1b[3J  clear scrollback (xterm/Windows Terminal extension)
    //   \x1b[2J  clear visible screen
    //   \x1b[H   cursor to top-left
    process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
    // Nudge PowerShell to redraw its prompt at the now-empty top.
    ptyProcess.write('\r');
  }
}

function showPrompt() {
  // Deliberately subtle: a dim ">" so a shoulder-surfer reads it as a
  // continuation prompt, not an AI prompt. Recorded into the transcript so
  // the resumed view ends at a ready prompt.
  aiWrite(DIM + '> ' + RESET);
}

// ---------------------------------------------------------------------------
// AI input editor (single-line, with backspace + ctrl-c)
// ---------------------------------------------------------------------------
function handleAiInput(data) {
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];

    if (ch === CTRL_C) {
      if (aiChild) {
        try { aiChild.kill(); } catch (_) {}
      }
      aiBuffer = '';
      aiWrite('^C\r\n');
      showPrompt();
      continue;
    }

    if (ch === CTRL_D) {
      // Ctrl-D in AI mode = drop back to shell
      mode = 'shell';
      aiBuffer = '';
      process.stdout.write('\r\n');
      ptyProcess.write('\r');
      return;
    }

    if (ch === ENTER_CR || ch === ENTER_LF) {
      const prompt = aiBuffer.trim();
      aiBuffer = '';
      aiWrite('\r\n');
      if (prompt.length > 0) {
        sendToClaude(prompt);
      } else {
        showPrompt();
      }
      continue;
    }

    if (ch === BACKSPACE || ch === BACKSPACE_ALT) {
      if (aiBuffer.length > 0) {
        aiBuffer = aiBuffer.slice(0, -1);
        // Erase one cell: move back, overwrite with space, move back again
        aiWrite('\b \b');
      }
      continue;
    }

    // Ignore other escape sequences for now (arrow keys etc.)
    if (ch === '\x1b') {
      // skip the rest of the escape sequence in this chunk
      while (i + 1 < data.length && data[i + 1] !== ENTER_CR && data[i + 1].charCodeAt(0) < 0x40) {
        i++;
      }
      // also consume the final byte
      if (i + 1 < data.length) i++;
      continue;
    }

    // Printable
    if (ch >= ' ') {
      aiBuffer += ch;
      aiWrite(ch);
    }
  }
}

// ---------------------------------------------------------------------------
// Claude invocation
// ---------------------------------------------------------------------------
function sendToClaude(prompt) {
  aiBusy = true;

  // Use --resume on every call after the first. Easiest: always pass
  // --session-id; Claude Code creates it on first use and reuses thereafter.
  const args = ['-p', prompt];
  if (aiFirstCall) {
    // Create the session with our known ID on the first call.
    args.push('--session-id', sessionId);
    aiFirstCall = false;
  } else {
    // Resume the same session on every subsequent call so Claude remembers
    // the conversation.
    args.push('--resume', sessionId);
  }
  args.push('--permission-mode', process.env.CLAUDE_GHOST_PERMISSION_MODE || 'bypassPermissions');

  // Optional model override (e.g. CLAUDE_GHOST_MODEL=opus)
  if (process.env.CLAUDE_GHOST_MODEL) {
    args.push('--model', process.env.CLAUDE_GHOST_MODEL);
  }

  aiChild = spawn('claude', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    cwd: process.cwd(),
    env: process.env,
  });

  aiChild.stdout.on('data', (chunk) => {
    // Raw mode terminals need \r\n, not bare \n. Strip OSC title-changes
    // so the terminal title doesn't flip to "claude".
    aiWrite(stripTitle(chunk.toString()).replace(/\r?\n/g, '\r\n'));
  });

  aiChild.stderr.on('data', (chunk) => {
    aiWrite(DIM + RED + stripTitle(chunk.toString()).replace(/\r?\n/g, '\r\n') + RESET);
  });

  aiChild.on('error', (err) => {
    aiWrite(RED + '\r\nclaude failed to launch: ' + err.message + RESET + '\r\n');
    aiBusy = false;
    aiChild = null;
    if (mode === 'ai') showPrompt();
  });

  aiChild.on('close', () => {
    aiBusy = false;
    aiChild = null;
    aiWrite('\r\n');
    if (mode === 'ai') showPrompt();
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
function cleanup() {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch (_) {}
  try { if (aiChild) aiChild.kill(); } catch (_) {}
}

process.on('exit', cleanup);
process.on('SIGINT', () => { /* swallow; Ctrl-C is routed to the PTY */ });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
