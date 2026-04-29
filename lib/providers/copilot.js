import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import { ProviderBase, cliIsInstalled, expandHome } from './base.js';

// GitHub Copilot internal usage API (same endpoint CodexBar uses)
const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user';

export class CopilotProvider extends ProviderBase {
    constructor(settings) {
        super('copilot', 'Copilot');
        this._settings = settings;
        this._session = new Soup.Session({ timeout: 10 });
    }

    async _findGitHubToken() {
        // Check file-based locations first (older gh versions)
        const locations = [
            expandHome('~/.config/gh/hosts.yml'),
            expandHome('~/.config/github-copilot/hosts.json'),
        ];

        for (const loc of locations) {
            if (!GLib.file_test(loc, GLib.FileTest.EXISTS)) continue;
            const [, bytes] = GLib.file_get_contents(loc);
            if (!bytes) continue;
            const text = new TextDecoder().decode(bytes);

            if (loc.endsWith('.yml')) {
                const m = text.match(/oauth_token:\s*([^\s\n]+)/);
                if (m) return m[1];
            } else if (loc.endsWith('.json')) {
                try {
                    const data = JSON.parse(text);
                    const ghData = data['github.com'] || data;
                    const t = ghData.oauth_token ?? ghData.token ?? null;
                    if (t) return t;
                } catch { /* skip */ }
            }
        }

        // Newer gh versions store the token in the system keyring — ask gh directly
        return this._runGhAuthToken();
    }

    _runGhAuthToken() {
        return new Promise((resolve) => {
            let ghBin = GLib.find_program_in_path('gh');
            if (!ghBin) { resolve(null); return; }

            let proc = null;
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8000, () => {
                if (proc) proc.force_exit();
                resolve(null);
                return GLib.SOURCE_REMOVE;
            });

            try {
                proc = Gio.Subprocess.new(
                    [ghBin, 'auth', 'token'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
                );
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        const [, stdout] = p.communicate_utf8_finish(res);
                        const token = stdout ? stdout.trim() : null;
                        GLib.Source.remove(timer);
                        resolve(token || null);
                    } catch {
                        GLib.Source.remove(timer);
                        resolve(null);
                    }
                });
            } catch {
                GLib.Source.remove(timer);
                resolve(null);
            }
        });
    }

    async detect() {
        const cliPath = this._settings.get_string('copilot-cli-path');
        const installed = cliIsInstalled(cliPath);
        const token = await this._findGitHubToken();
        return { installed, authenticated: !!token };
    }

    async fetchQuota() {
        this._inFlight = true;
        try {
            const cliPath = this._settings.get_string('copilot-cli-path');
            const installed = cliIsInstalled(cliPath);
            if (!installed) return { installed: false, authenticated: false };

            const ghToken = await this._findGitHubToken();
            if (!ghToken) {
                return {
                    installed: true,
                    authenticated: false,
                    error: 'GitHub token not found — run: gh auth login',
                };
            }

            const result = await this._fetchUsage(ghToken);
            return { installed: true, authenticated: true, ...result };
        } catch (e) {
            return { installed: true, authenticated: true, error: e.message };
        } finally {
            this._inFlight = false;
        }
    }

    async _fetchUsage(ghToken) {
        const msg = Soup.Message.new('GET', COPILOT_USER_URL);
        // Use the GitHub OAuth token directly (no copilot_internal/v2/token step needed)
        msg.request_headers.append('Authorization', `token ${ghToken}`);
        msg.request_headers.append('Accept', 'application/json');
        // Headers required by the Copilot internal API
        msg.request_headers.append('Editor-Version', 'vscode/1.96.2');
        msg.request_headers.append('Editor-Plugin-Version', 'copilot-chat/0.26.7');
        msg.request_headers.append('User-Agent', 'GitHubCopilotChat/0.26.7');
        msg.request_headers.append('X-Github-Api-Version', '2025-04-01');

        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                try { resolve(sess.send_and_read_finish(res)); }
                catch (e) { reject(e); }
            });
        });

        const status = msg.get_status();
        if (status === 401 || status === 403)
            return { error: 'GitHub token rejected — run: gh auth login' };
        if (status !== 200)
            return { error: `Copilot usage API returned HTTP ${status}` };

        const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        return this._parseUsageResponse(json);
    }

    _parseUsageResponse(json) {
        // Response: { quotaSnapshots: { premiumInteractions: { percentRemaining: 75 }, chat: { ... } } }
        // Field names may be camelCase or snake_case depending on API version
        const snapshots = json.quotaSnapshots ?? json.quota_snapshots ?? {};

        const premium = snapshots.premiumInteractions ?? snapshots.premium_interactions;
        const chat    = snapshots.chat;

        const makeWindow = (s, label) => {
            if (!s) return null;
            if (s.isPlaceholder === true || s.is_placeholder === true) return null;
            // Skip unlimited snapshots (no quota cap to display)
            if (s.unlimited === true) return null;
            const pct = s.percentRemaining ?? s.percent_remaining ?? null;
            if (pct === null) return null;
            const resetMs = s.quota_reset_at ?? s.quotaResetAt ?? 0;
            const resetAt = resetMs > 0 ? new Date(resetMs * 1000) : null;
            return {
                remaining: Math.max(0, Math.min(1, pct / 100)),
                resetAt,
                label,
            };
        };

        const premiumWindow = makeWindow(premium, 'Premium Requests');
        const chatWindow    = makeWindow(chat,    'Chat');

        if (premiumWindow && chatWindow) {
            return { session: premiumWindow, weekly: chatWindow };
        }
        if (premiumWindow) return { session: premiumWindow };
        if (chatWindow)    return { session: chatWindow };

        return { error: 'No quota data in response', rawResponse: json };
    }
}
