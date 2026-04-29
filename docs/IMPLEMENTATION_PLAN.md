# AI Usage Bar — Implementation Plan

> **Status:** Draft v1 · 2026-04-29
> **Companion to:** `REQUIREMENTS.md` (source of truth)

This document describes *how* we will deliver the extension specified in `REQUIREMENTS.md`. The reference architecture is the existing `llm-text-pro@sokolowski.tech` project (single-file `extension.js`, single-file `prefs.js`, `schemas/`, `install.sh`). We mirror that layout where it fits and split only when complexity warrants.

When `REQUIREMENTS.md` and this plan disagree, requirements win — update this plan to match, do not silently drift.

---

## 1. Project layout

```
gnome-ai-usage-bar/
├── metadata.json
├── extension.js                 # Indicator + scheduler + provider registry
├── prefs.js                     # Adw preferences window
├── stylesheet.css               # Panel meter colors, popup styling
├── install.sh                   # Mirror of llm-text-pro install.sh
├── lib/
│   ├── meter.js                 # Custom St.DrawingArea two-bar meter widget
│   ├── scheduler.js             # Refresh timer + suspend/resume hook
│   ├── store.js                 # GSettings wrapper + cached-quota JSON blob
│   └── providers/
│       ├── base.js              # Provider interface + shared helpers
│       ├── claude.js            # OAuth → /api/oauth/usage; PTY /usage fallback
│       ├── codex.js             # JSON-RPC over `codex app-server` + PTY /status
│       ├── gemini.js            # OAuth bearer → cloudcode-pa retrieveUserQuota
│       ├── copilot.js           # GitHub Copilot internal usage API
│       └── opencode.js          # `opencode usage` JSON command
├── schemas/
│   └── org.gnome.shell.extensions.ai-usage-bar.gschema.xml
├── po/                          # Empty for now; gettext-ready
└── docs/
    ├── REQUIREMENTS.md
    └── IMPLEMENTATION_PLAN.md
```

**Why split `lib/`?** llm-text-pro is one 1.8k-line file because actions are uniform. Here providers diverge wildly (HTTP vs RPC vs PTY vs file scan). One file per provider is cheaper to read and test than a giant switch.

## 2. Provider interface (`lib/providers/base.js`)

Every provider exports a singleton implementing:

```js
{
  id: 'claude',                       // matches GSettings key prefix
  displayName: 'Claude',
  iconName: 'claude-symbolic',        // falls back to dialog-information

  detect(): Promise<{
    installed: boolean,               // CLI on PATH?
    authenticated: boolean,           // creds present?
    error?: string,
  }>,

  fetchQuota(cancellable): Promise<{
    session?:  { remainingPct, resetEpochSec, label },
    weekly?:   { remainingPct, resetEpochSec, label },
    raw?:      object,                // for debugging in prefs
    error?:    string,
  }>,
}
```

The orchestrator in `extension.js` only ever sees this interface. New providers drop into `lib/providers/` and a one-line registration in `extension.js` — that is the test for G2.

## 3. Scheduler (`lib/scheduler.js`)

- One `GLib.timeout_add_seconds` keyed by `refresh-interval-seconds` (0 ⇒ no timer).
- A per-provider in-flight flag so overlapping ticks are no-ops (F2).
- `Gio.DBus.system.signal_subscribe('org.freedesktop.login1', ..., 'PrepareForSleep', ...)` — on `false` (waking up), force a refresh (F8).
- All async work uses `Gio.Subprocess` (`STDIN_PIPE | STDOUT_PIPE | STDERR_PIPE`) and `Soup.Session.send_and_read_async`. No `GLib.spawn_command_line_sync`. No blocking `JSON.parse` on multi-MB inputs (cap reads).

## 4. Provider implementation notes

### 4.1 Claude (highest priority)

- **OAuth path:**
  - Read `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`).
  - Extract bearer.
  - `GET https://api.anthropic.com/api/oauth/usage` with headers `Authorization: Bearer <t>`, `anthropic-beta: oauth-2025-04-20`.
  - Map `five_hour` → session, `seven_day` → weekly.
- **Fallback:** spawn `claude --allowed-tools "" /usage` in a PTY (use `Gio.Subprocess` with `STDIN_PIPE`; we don't need a real TTY for `/usage`'s machine output but if rendering is required, fall back to `script -qc`). Parse "Current session" / "Current week" lines via regex.
- **Last resort:** scan `~/.claude/projects/**/*.jsonl` for entries within last 5h/7d, sum tokens, surface as a *count* (not %) since limit is unknown.

### 4.2 Gemini

- Read `~/.gemini/oauth_creds.json`.
- If `expiry_date <= now + 60s`, refresh via `POST https://oauth2.googleapis.com/token` (need client_id/secret — same constants codexbar extracts from `oauth2.js`; we hardcode the public Gemini CLI client ID rather than parse JS).
- `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` → returns per-model daily quota; map highest-tier model to session bar, hide weekly bar.

### 4.3 Codex

- Skip silently when `which codex` returns nothing — true on this machine right now.
- **RPC path:** `Gio.Subprocess.spawnv(['codex','-s','read-only','-a','untrusted','app-server'])`. Send three JSON-RPC messages over stdin (`initialize`, `account/read`, `account/rateLimits/read`), read responses from stdout. Treat as best-effort.
- **PTY path:** spawn interactively, send `/status\n`, scrape `5h limit` and `Weekly limit` lines.

### 4.4 Copilot

- Read token from `~/.copilot/config.json`.
- Hit GitHub's internal endpoint used by `gh copilot` for billing; the exact URL needs reverse-engineering against the installed CLI on first dev day. If it proves brittle, demote to "unknown" and ship the bar grayed.

### 4.5 OpenCode

- `opencode usage --json` if available; otherwise hide.

## 5. UI

### 5.1 Meter widget (`lib/meter.js`)

- `St.DrawingArea`, 22×16 px (matches default panel icon size).
- Cairo: top bar 22×6, 2px gap, bottom bar 22×2 hairline.
- Colors driven by CSS classes (`meter-ok`, `meter-warn`, `meter-crit`, `meter-stale`) rather than hex literals — themes can restyle.
- A monochrome symbolic SVG fallback for the panel `St.Icon` when the user disables the custom drawing (some themes mangle DrawingArea).

### 5.2 Popup

- Reuse `PopupMenu.PopupBaseMenuItem` patterns from `llm-text-pro/extension.js:194-260` (backend grid).
- Each provider row: `St.BoxLayout` with `St.Icon`, name, two `MeterStripe` mini-widgets, time-to-reset label.
- Refresh timestamp updates via a 5s GLib timer that only mutates label text.

### 5.3 Preferences (`prefs.js`)

- Mirror `llm-text-pro/prefs.js` structure: top-level `Adw.PreferencesWindow`, one page per concern.
- Use `Adw.ExpanderRow` per provider with a "Test" button that calls `provider.detect()` and shows the result inline. Saves users from "why doesn't it work" debugging.

## 6. Settings

- `glib-compile-schemas schemas/` runs in `install.sh` (copy from llm-text-pro).
- `Gio.Settings` wrapper in `lib/store.js` exposes typed getters/setters and emits a single `changed` signal so the indicator can subscribe once.
- The cached-quota JSON blob (`cached-quota-json`) is written debounced (1s) and capped to 4 KB to avoid bloating dconf.

## 7. Phased delivery

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0 — Skeleton** | `metadata.json`, schema, empty indicator, install.sh, builds and enables on GNOME 50 | `gnome-extensions enable` succeeds; panel shows a placeholder icon |
| **P1 — Claude OAuth** | `lib/providers/claude.js` OAuth path, scheduler, two-bar meter | Real Claude session+weekly numbers visible; matches `claude /usage` output |
| **P2 — Gemini + Copilot** | Two more providers + active-provider switching | Switching providers redraws icon; broken provider doesn't break others |
| **P3 — Codex + OpenCode** | RPC + PTY + `opencode usage` | All five providers either show data or "unknown" — never crash |
| **P4 — Prefs UI** | Adw preferences with Test buttons, thresholds, intervals | All settings wired; restart-free changes |
| **P5 — Polish** | Suspend/resume, persisted cache, journalctl hygiene, README, install.sh | Acceptance criteria 1–6 in REQUIREMENTS.md pass |
| **P6 (post-v1)** | D-Bus export, merge-mode icon, OQ3/OQ2 | Separate spec |

Each phase ends with a manual smoke test on GNOME 50 (this machine) and a check that the extension still loads on GNOME 45 (Wayland VM).

## 8. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Provider APIs change without notice (Claude OAuth, Gemini internal endpoint) | High | High | Version-tag every parser; surface raw JSON in Prefs → "Test" so users can paste it into an issue; have PTY fallback for Claude |
| `Gio.Subprocess` PTY rendering needs a real TTY | Medium | Medium | Use `script -qec '...' /dev/null` wrapper if direct spawn produces unrendered output; document in provider files |
| Custom `St.DrawingArea` breaks under exotic themes | Medium | Low | Provide symbolic-icon fallback toggle in prefs |
| dconf bloat from cached-quota blob | Low | Low | 4 KB cap + 1s debounce |
| GNOME Shell main-loop stalls during HTTP | Low | High | All HTTP via async `Soup.Session.send_and_read_async`; subprocess via async I/O streams; no `*_sync` calls anywhere |
| User has no codex installed (true on this dev machine) | Certain | None | Provider self-disables when CLI missing — already in spec (F1) |

## 9. Testing strategy

- **Unit-ish:** Each provider module exposes a `parse()` pure function over fixture strings (saved under `tests/fixtures/<provider>/`). Run via `gjs tests/run.js` — no Jest, no Node, no network.
- **Integration:** A `dev/dev-shell.sh` that runs a nested GNOME Shell session (`dbus-run-session -- gnome-shell --nested --wayland`) with the extension installed.
- **Manual:** Acceptance criteria 1–6 from REQUIREMENTS.md, walked through before each release.

## 10. Versioning & release

- Version starts at `1` in `metadata.json`, incremented on every `install.sh` package (matches llm-text-pro convention).
- Tag releases `v1`, `v2`, … in git; push to `git.sokolowski.tech/david/ai-usage-bar@sokolowski.tech` (TBD).
- License: GPLv3 (matches llm-text-pro).

## 11. What we are *not* building (re-stated for clarity)

- Inference, prompts, hotkeys → `llm-text-pro` already does this.
- Browser cookie scraping → see NG4.
- macOS / Windows → see NG5.
- Cost projections for paid APIs → see NG3.

---

**Next concrete step (when implementation begins):** Phase P0 — write `metadata.json`, the gschema XML, and a stub `extension.js` that adds an empty indicator, then verify `gnome-extensions enable ai-usage-bar@sokolowski.tech` works on this machine.
