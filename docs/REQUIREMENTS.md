# AI Usage Bar — Requirements (Source of Truth)

> **Status:** Draft v1 · 2026-04-29
> **Owner:** David Sokolowski
> **UUID (proposed):** `ai-usage-bar@sokolowski.tech`
> **Schema id (proposed):** `org.gnome.shell.extensions.ai-usage-bar`

This document is the **source of truth** for what the extension must do. Code, schemas, README, and tests must conform to it. When intent changes, update this document **first**, then propagate. The companion document is `IMPLEMENTATION_PLAN.md` (the *how*); this one is the *what* and *why*.

---

## 1. Vision

A GNOME Shell panel indicator that shows, at a glance, **how much AI quota you have left** across the AI coding CLIs you actually use — Codex, Claude, Gemini, Copilot, OpenCode — with a two-bar meter (session window + weekly window) inspired by [steipete/codexbar](https://github.com/steipete/codexbar) on macOS, brought natively to GNOME 45–50.

It is the read-only dashboard counterpart to `llm-text-pro@sokolowski.tech`, which *uses* these CLIs. This extension *monitors* them.

## 2. Goals

- **G1 — Glanceable status:** A panel icon that visually encodes session + weekly remaining quota for the active provider, updated without user interaction.
- **G2 — Multi-provider:** First-class support for Codex, Claude, Gemini, Copilot, OpenCode. Adding a sixth provider must require touching at most one provider module + schema.
- **G3 — Offline-first / local parsing:** Prefer reading local CLI files (JSONL logs, OAuth creds) over network calls. Network calls only when a provider exposes no usable local file.
- **G4 — Zero-config common case:** If a user already authenticated `claude`, `gemini`, etc., the extension shows usage with no further setup.
- **G5 — GNOME-native UX:** Panel button with PopupMenu (mirrors `llm-text-pro` patterns), a Preferences window built on `Adw.PreferencesPage`, native icons, no external assets.
- **G6 — Safe by default:** No code execution beyond invoking the user's already-installed provider CLI binaries with read-only flags. No telemetry, no third-party endpoints.

## 3. Non-goals

- **NG1:** Sending prompts / running inference. (That is `llm-text-pro`'s job.)
- **NG2:** Per-request token counting for arbitrary apps. We track *quota windows* the providers report, not arbitrary observability.
- **NG3:** Cost projections for paid pay-as-you-go endpoints (OpenRouter, OpenAI direct API). Out of scope until users ask.
- **NG4:** Browser cookie scraping (codexbar does this on macOS Safari/Chrome). On Linux this is fragile and privacy-loaded — we deliberately skip it for v1.
- **NG5:** macOS / Windows. GNOME-only.

## 4. Target users

- Heavy users of AI coding CLIs who hit the 5-hour and weekly windows and want to plan their day around remaining quota.
- Developers running multiple providers in parallel and switching when one is exhausted.
- Power users who already have `claude`, `gemini`, `copilot`, `codex`, `opencode` installed and authenticated.

## 5. Supported providers (v1 scope)

For each provider we define: **enabled-when**, **data source**, **session window**, **weekly window**, and **fallback**. A provider that fails silently must degrade to "unknown" in the UI without breaking other providers.

| Provider | Enabled when | Primary data source | Session window | Weekly window | Fallback |
|---|---|---|---|---|---|
| **Claude** | `claude` on `$PATH` **and** `~/.claude/.credentials.json` exists | OAuth `GET https://api.anthropic.com/api/oauth/usage` (header `anthropic-beta: oauth-2025-04-20`); maps `five_hour` → session, `seven_day` → weekly | yes | yes | Parse `claude` PTY `/usage` output; if both fail, count tokens in `~/.claude/projects/**/*.jsonl` for last 5h / 7d (best-effort heuristic, no hard reset time) |
| **Gemini** | `gemini` on `$PATH` **and** `~/.gemini/oauth_creds.json` exists | `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` with bearer token from `oauth_creds.json` (refresh via `https://oauth2.googleapis.com/token`) | per-model daily | per-model daily | Show "auth required" if creds missing or refresh fails |
| **Codex** | `codex` on `$PATH` **and** `~/.codex/auth.json` exists | RPC: spawn `codex -s read-only -a untrusted app-server`, send `account/rateLimits/read` over stdio JSON-RPC | yes (5h) | yes | PTY: spawn `codex` interactively, send `/status`, parse `5h limit` / `Weekly limit` lines |
| **Copilot** | `copilot` on `$PATH` **and** `~/.copilot/config.json` exists | GitHub Copilot internal usage API using token from `~/.copilot/config.json` | n/a (numeric premium-request balance) | n/a | "Unknown" if API call fails |
| **OpenCode** | `opencode` on `$PATH` | `opencode usage` command (or equivalent JSON command) | depends on configured provider | depends | "Unknown" |

**Active provider:** the one whose meter the panel icon visualizes. The user picks it; default = first enabled in priority order Claude → Codex → Gemini → Copilot → OpenCode.

**Per-system reality check (this machine):** `codex` is **not** installed; `claude`, `gemini`, `copilot`, `opencode` are. The Codex provider must therefore disable itself gracefully when its CLI is absent.

## 6. UX requirements

### 6.1 Panel indicator

- A `PanelMenu.Button` with a custom `St.DrawingArea` (or two stacked `St.Bin`s) rendering a **two-bar meter**:
  - **Top bar** = session window (5-hour for Claude/Codex, daily for Gemini, premium-request balance for Copilot).
  - **Bottom bar** = weekly window (hairline; for providers without a weekly concept, hidden).
- Bar fill = remaining quota (not used). 100% full = fresh.
- Color states: ≥50% normal, 20–50% warning (amber), <20% critical (red), error/stale = dimmed.
- Tooltip on hover: `<provider> · session N% · weekly N% · resets in HH:MM`.
- **Merge mode** (post-v1): one icon switches between providers on click. v1 = single active provider only.

### 6.2 Popup menu (click panel icon)

Top-to-bottom:

1. **Header row:** active provider name + "Refresh now" button (`view-refresh-symbolic`).
2. **Per-provider rows** (one per *enabled* provider):
   - Provider icon + name
   - Session bar + percent + reset countdown
   - Weekly bar + percent + reset countdown (hidden if N/A)
   - Click row → make it the active provider
3. Separator.
4. **Last refreshed:** "12s ago" (live).
5. **Auto-refresh interval:** submenu with presets `Manual / 1m / 2m / 5m / 15m` (default 5m).
6. **Open Preferences** (`gnome-extensions prefs`).

### 6.3 Preferences window (`prefs.js`)

`Adw.PreferencesWindow` with three pages, modeled on `llm-text-pro/prefs.js`:

- **Providers** — one `Adw.ExpanderRow` per provider showing detected status (`installed`, `authenticated`, `last error`), an enable toggle, and provider-specific overrides (e.g. custom CLI path, custom `CLAUDE_CONFIG_DIR`).
- **Display** — active provider, refresh interval, color thresholds, show/hide weekly bar, panel position.
- **About** — version, source URL, license.

## 7. Functional requirements

- **F1** Detect each provider on extension enable; cache the detection result for 30s.
- **F2** Refresh quota at the configured interval; never run two refreshes for the same provider concurrently.
- **F3** Persist last-known-good quota across sessions (via `Gio.Settings` key holding a JSON blob, capped at ~4 KB) so the panel shows stale-but-useful data immediately on login.
- **F4** Fail isolated: a broken provider must log to `journalctl /usr/bin/gnome-shell` once per hour at most, never spam. Other providers must continue refreshing.
- **F5** All HTTP calls use libsoup 3 (`Soup.Session`) with a 10-second timeout and no redirects to non-allowlisted hosts.
- **F6** All CLI invocations use `Gio.Subprocess` with read-only flags; never write to provider data directories.
- **F7** Respect `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `GEMINI_CONFIG_DIR` environment variables when set.
- **F8** Refresh on resume from suspend (subscribe to `org.freedesktop.login1` `PrepareForSleep` signal) — quota windows commonly cross suspend boundaries.

## 8. Non-functional requirements

- **NF1 — GNOME Shell:** 45, 46, 47, 48, 49, 50 (matches `llm-text-pro`).
- **NF2 — Performance:** Idle CPU < 0.1% averaged over 1 minute. A refresh must complete in < 2 s p95 per provider; UI must never block the shell main loop (use async Gio APIs).
- **NF3 — Memory:** < 30 MB RSS added to `gnome-shell` after 24h.
- **NF4 — Privacy:** No outbound network requests except to the provider's own documented endpoint. No analytics, no error reporting.
- **NF5 — Reliability:** Surviving 7 consecutive provider failures must not crash the extension; recover automatically when the provider returns.
- **NF6 — Localization:** All user-facing strings wrapped in `_()` and a `po/` directory present (translations may come later).
- **NF7 — Style:** GJS only, no bundlers, no Node toolchain. Mirror the file layout of `llm-text-pro@sokolowski.tech`.

## 9. Settings keys (`org.gnome.shell.extensions.ai-usage-bar`)

| Key | Type | Default | Purpose |
|---|---|---|---|
| `active-provider` | `s` | `'claude'` | Which provider drives the panel icon |
| `enabled-providers` | `as` | `['claude','gemini','copilot','opencode']` | Which providers to probe at all |
| `refresh-interval-seconds` | `i` | `300` | 0 = manual; presets enforced in UI |
| `warning-threshold-pct` | `i` | `50` | Amber below this |
| `critical-threshold-pct` | `i` | `20` | Red below this |
| `show-weekly-bar` | `b` | `true` | Bottom hairline |
| `claude-cli-path` | `s` | `'claude'` | Override |
| `codex-cli-path` | `s` | `'codex'` | Override |
| `gemini-cli-path` | `s` | `'gemini'` | Override |
| `copilot-cli-path` | `s` | `'copilot'` | Override |
| `opencode-cli-path` | `s` | `'opencode'` | Override |
| `claude-config-dir` | `s` | `''` (= use `CLAUDE_CONFIG_DIR` or `~/.claude`) | Override |
| `cached-quota-json` | `s` | `'{}'` | Last-known-good blob, written by extension |

## 10. Open questions / decisions to revisit

- **OQ1** — Should we support the OpenRouter / online-API path (token cost from response headers)? *Decision:* defer, see NG3.
- **OQ2** — Merge-mode icon (codexbar's killer feature). *Decision:* post-v1, behind a setting.
- **OQ3** — Should we expose a D-Bus interface so other tools (Waybar users, scripts) can read quota? *Decision:* yes for v1.1, name `tech.sokolowski.AIUsageBar`.
- **OQ4** — Codex RPC protocol stability. *Decision:* treat PTY `/status` parser as the supported path; RPC is best-effort.

## 11. Acceptance criteria (v1)

The extension is shippable when:

1. On a fresh GNOME 50 install with `claude` and `gemini` authenticated, enabling the extension shows live two-bar meters within 5 seconds, with no manual configuration.
2. Disabling the extension leaves no timers, no subprocesses, and no panel artifacts (verified by `looking-glass`).
3. Toggling the active provider in the menu redraws the panel icon within 1 frame.
4. Suspending the laptop for 30 minutes and resuming triggers a refresh and updates the icon within 2 seconds.
5. Removing `~/.claude/.credentials.json` causes the Claude row to show "auth required" without affecting other providers.
6. `journalctl --user -u org.gnome.Shell.target -p warning -g ai-usage-bar` is empty after 1 hour of normal use.
