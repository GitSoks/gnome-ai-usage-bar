<div align="center">
  <img src="https://raw.githubusercontent.com/GitSoks/gnome-ai-usage-bar/main/icons/gemini-symbolic.svg" width="64" alt="AI Usage Bar Logo">
  <h1>AI Usage Bar</h1>
  <p><b>A GNOME Shell extension that shows your remaining AI quota as a live meter in the top panel.</b></p>
  
  [![GNOME Shell 45-50](https://img.shields.io/badge/GNOME%20Shell-45%20|%2046%20|%2047%20|%2048%20|%2049%20|%2050-blue.svg)](https://extensions.gnome.org)
  [![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
</div>

<br />

Supports **Claude**, **Gemini**, **Codex (OpenAI)**, **GitHub Copilot**, and **OpenCode** — all at once!

Inspired by [codexbar](https://github.com/steipete/codexbar) for macOS.

---

## ✨ Features

- **Live Quota Meter**: A compact two-bar meter on the right side of your panel.
  - **Tall bar**: Your session window quota.
  - **Thin hairline bar**: Your weekly window quota.
- **Color-Coded Status**: Both bars change color as your quota runs low (Green → Amber → Red).
- **Detailed Popup**: Click the meter to view per-provider detail rows, progress bars, reset countdowns, and a manual refresh button.
- **Quick Switching**: Switch the active provider directly from the popup without opening preferences.
- **Smart Refresh**: Automatically refreshes when waking from sleep and optionally polls in the background (1, 2, 5, or 15 mins).

*(Screenshot placeholder - Add a screenshot of the panel and popup here!)*
<!-- <img src="screenshot.png" alt="AI Usage Bar Screenshot" width="400"> -->

---

## 🔌 Supported Providers

| Provider | Quota type | Auth method |
|---|---|---|
| **Claude** (Anthropic) | 5-hour session + 7-day weekly | `claude` CLI / `~/.claude/.credentials.json` |
| **Gemini** (Google) | Per-model bucket quota | `gemini` CLI / `~/.gemini/oauth_creds.json` |
| **Codex** (OpenAI) | 5-hour session + 7-day weekly | `codex` CLI / `~/.codex/auth.json` |
| **GitHub Copilot** | Premium interactions (monthly) | `gh auth login` / system keyring |
| **OpenCode** | USD spend (cost-based) | `opencode` CLI / local SQLite DB |

---

## 📋 Requirements

- **GNOME Shell 45 – 50**
- The CLI tool for each provider you want to monitor must be installed and authenticated on your system.

---

## 🚀 Installation

### From extensions.gnome.org (Recommended)

Search for **AI Usage Bar** on the [GNOME Extensions](https://extensions.gnome.org/) website or install it directly from the extension app.

### Manual Installation

If you want to build from source or use the latest git version:

```bash
# Clone into the GNOME extensions directory
git clone https://github.com/GitSoks/gnome-ai-usage-bar.git \
    ~/.local/share/gnome-shell/extensions/ai-usage-bar@sokolowski.tech

# Compile the settings schema
glib-compile-schemas \
    ~/.local/share/gnome-shell/extensions/ai-usage-bar@sokolowski.tech/schemas/

# Enable the extension
gnome-extensions enable ai-usage-bar@sokolowski.tech
```

> **Note:** Log out and log back in (or restart the shell with `Alt+F2` → `r` on X11) if the extension does not appear immediately.

---

## ⚙️ Provider Setup

Each provider must be installed and authenticated independently. The extension reads credentials from the same locations the CLI tools use — no separate login is required.

<details>
<summary><b>Claude</b></summary>

```bash
npm install -g @anthropic-ai/claude-code
claude   # follow the browser login prompt
```
</details>

<details>
<summary><b>Gemini</b></summary>

```bash
npm install -g @google/gemini-cli
gemini   # follow the browser login prompt
```
</details>

<details>
<summary><b>Codex</b></summary>

```bash
npm install -g @openai/codex
codex    # follow the browser login prompt
```
</details>

<details>
<summary><b>GitHub Copilot</b></summary>

```bash
# Install the GitHub CLI: https://cli.github.com
gh auth login
```
*The extension reads the token from the system keyring via `gh auth token`. No additional steps are needed.*
</details>

<details>
<summary><b>OpenCode</b></summary>

```bash
npm install -g opencode-ai
opencode  # follow the browser login prompt
```
*OpenCode is cost-based rather than quota-based. Set optional 5-hour and 7-day budget limits in **Preferences → Providers → OpenCode** to show a remaining-budget bar instead of raw USD figures.*
</details>

---

## 🛠️ Configuration

Open **Preferences** from the popup menu or from the Extensions app to customize your experience.

### Providers Settings
- **Active provider:** Choose which provider's quota drives the main panel bar and icon.
- **Live Status:** View the last-fetched quota for all providers with a quick refresh button.
- **Provider Configuration:** Enable/disable individual providers, and override default CLI paths.

### Display Settings
- **Show weekly bar:** Toggle the thin hairline bar below the session bar.
- **Percentage display:** Show none, session only, weekly only, or both as text next to the bar.
- **Warning/Critical thresholds:** The bar turns amber or red when remaining quota falls below these percentages (defaults: 50% and 20%).
- **Refresh interval:** Choose automatic background polling: manual only, 1 min, 2 min, 5 min, or 15 min.

---

## 💡 Behavior Notes

- ⏳ **Stale data:** If no refresh has happened in the past 30 minutes, the bar renders at reduced opacity to signal the data may be outdated.
- 💤 **Resume from suspend:** The extension listens for the system sleep signal and refreshes quota automatically 3 seconds after the machine wakes.
- 💾 **Cache:** The last-known quota is persisted across GNOME Shell restarts via GSettings, so the bar is never blank on startup.
- 🔄 **Multiple providers:** All enabled providers are polled in parallel. You can watch the full detail for every provider in the popup, regardless of which one is active in the panel.

---

## 📄 License

This project is licensed under the **GPLv3** — see the [LICENSE](LICENSE) file for details.

## 👨‍💻 Author

David Sokolowski — [Website/Git](https://git.sokolowski.tech/david) | [GitHub](https://github.com/GitSoks)
