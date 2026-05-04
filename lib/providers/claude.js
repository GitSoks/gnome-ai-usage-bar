import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import { ProviderBase, cliIsInstalled, readFileJson, expandHome } from './base.js';

const USAGE_URL  = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL  = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID  = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const BETA_HEADER = 'anthropic-beta';
const BETA_VALUE  = 'oauth-2025-04-20';

export class ClaudeProvider extends ProviderBase {
    constructor(settings) {
        super('claude', 'Claude');
        this._settings = settings;
        this._session = new Soup.Session({ timeout: 10 });
    }

    destroy() {
        try { this._session?.abort(); } catch { /* ignore */ }
        this._session = null;
        super.destroy();
    }

    _configDir() {
        const override = this._settings.get_string('claude-config-dir');
        if (override && override.trim()) return expandHome(override.trim());
        const envDir = GLib.getenv('CLAUDE_CONFIG_DIR');
        if (envDir) return envDir;
        return GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
    }

    _credsPath() {
        return GLib.build_filenamev([this._configDir(), '.credentials.json']);
    }

    _loadToken() {
        const creds = readFileJson(this._credsPath());
        if (!creds?.claudeAiOauth) return null;
        const oauth = creds.claudeAiOauth;
        const token = oauth.accessToken || oauth.access_token;
        if (!token) return null;
        // expiresAt can be ISO string or epoch ms
        const exp = oauth.expiresAt || oauth.expires_at;
        const expMs = typeof exp === 'number'
            ? (exp > 1e12 ? exp : exp * 1000)
            : (exp ? new Date(exp).getTime() : null);
        if (expMs && expMs < Date.now() + 30000) return null; // expired / expiring soon
        return token;
    }

    async detect() {
        const cliPath = this._settings.get_string('claude-cli-path');
        const installed = cliIsInstalled(cliPath);
        const credsExist = GLib.file_test(this._credsPath(), GLib.FileTest.EXISTS);
        const authenticated = credsExist && this._loadToken() !== null;
        return { installed, authenticated };
    }

    async _refreshToken(refreshToken) {
        const body = [
            'grant_type=refresh_token',
            `refresh_token=${encodeURIComponent(refreshToken)}`,
            `client_id=${encodeURIComponent(CLIENT_ID)}`,
        ].join('&');

        const msg = Soup.Message.new('POST', TOKEN_URL);
        msg.set_request_body_from_bytes(
            'application/x-www-form-urlencoded',
            new GLib.Bytes(new TextEncoder().encode(body))
        );
        msg.request_headers.append(BETA_HEADER, BETA_VALUE);

        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                try { resolve(sess.send_and_read_finish(res)); }
                catch (e) { reject(e); }
            });
        });

        if (msg.get_status() !== 200)
            throw new Error(`Token refresh failed: HTTP ${msg.get_status()}`);

        const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        if (!json.access_token) throw new Error('No access_token in refresh response');

        // Persist updated token back to credentials file
        try {
            const creds = readFileJson(this._credsPath()) || {};
            const expMs = json.expires_in ? Date.now() + json.expires_in * 1000 : null;
            creds.claudeAiOauth = {
                ...creds.claudeAiOauth,
                accessToken: json.access_token,
                ...(expMs       ? { expiresAt:     expMs             } : {}),
                ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
            };
            GLib.file_set_contents(this._credsPath(), JSON.stringify(creds, null, 2));
        } catch { /* non-fatal — token still works this session */ }

        return json.access_token;
    }

    async fetchQuota() {
        this._inFlight = true;
        try {
            const cliPath = this._settings.get_string('claude-cli-path');
            const installed = cliIsInstalled(cliPath);
            if (!installed) return { installed: false, authenticated: false };

            const credsExist = GLib.file_test(this._credsPath(), GLib.FileTest.EXISTS);
            if (!credsExist)
                return { installed: true, authenticated: false, error: 'No credentials — run claude once to authenticate' };

            let token = this._loadToken();

            // Token expired or missing — try a silent refresh before giving up
            if (!token) {
                const creds = readFileJson(this._credsPath());
                const rt = creds?.claudeAiOauth?.refreshToken || creds?.claudeAiOauth?.refresh_token;
                if (rt) {
                    try {
                        token = await this._refreshToken(rt);
                    } catch (e) {
                        console.error('AIUsageBar: Claude token refresh failed:', e.message);
                    }
                }
            }

            if (!token) {
                const localData = this._scanJsonlLogs();
                return {
                    installed: true,
                    authenticated: true,
                    error: 'Token expired — run claude once to re-authenticate',
                    ...(localData ? { cost: localData } : {}),
                };
            }

            const result = await this._fetchOAuthUsage(token);
            return { installed: true, authenticated: true, ...result };
        } catch (e) {
            return { installed: true, authenticated: true, error: e.message };
        } finally {
            this._inFlight = false;
        }
    }

    async _fetchOAuthUsage(token) {
        const msg = Soup.Message.new('GET', USAGE_URL);
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        msg.request_headers.append(BETA_HEADER, BETA_VALUE);
        msg.request_headers.append('Content-Type', 'application/json');
        msg.request_headers.append('User-Agent', 'claude-code/2.1.119');

        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                try { resolve(sess.send_and_read_finish(res)); }
                catch (e) { reject(e); }
            });
        });

        const status = msg.get_status();
        if (status === 401) return { authenticated: false, error: 'Token rejected — run claude once to re-authenticate' };
        if (status !== 200) return { error: `API returned HTTP ${status}` };

        const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        return this._parseUsageResponse(json);
    }

    _parseUsageResponse(json) {
        const result = {};

        const parseWindow = (obj) => {
            if (!obj) return null;
            // The API returns "utilization" (0.0–1.0 fraction) and "resets_at".
            // Older/alternative shapes fall back to percentage-based fields.
            let remaining = null;
            if (obj.utilization !== undefined && obj.utilization !== null) {
                // utilization is 0–100 (percentage used), so remaining = 1 - pct/100
                remaining = Math.max(0, 1 - obj.utilization / 100);
            } else {
                const usedPct = obj.used_percentage ?? obj.usedPercentage ?? obj.percent_used ?? null;
                if (usedPct !== null) remaining = Math.max(0, 1 - usedPct / 100);
            }
            const resetStr = obj.resets_at ?? obj.resetsAt ?? obj.reset_at ?? obj.resetAt ?? obj.reset_time ?? null;
            const resetAt = resetStr ? new Date(resetStr) : null;
            if (remaining === null) return null;
            return { remaining, resetAt };
        };

        const sessionData = parseWindow(json.five_hour ?? json.fiveHour ?? json.session);
        if (sessionData) result.session = { ...sessionData, label: 'Session (5h)' };

        const weeklyData = parseWindow(json.seven_day ?? json.sevenDay ?? json.weekly);
        if (weeklyData) result.weekly = { ...weeklyData, label: 'Weekly' };

        // Add local cost data regardless
        const cost = this._scanJsonlLogs();
        if (cost) result.cost = cost;

        return result;
    }

    _scanJsonlLogs() {
        const projectsDir = GLib.build_filenamev([this._configDir(), 'projects']);
        if (!GLib.file_test(projectsDir, GLib.FileTest.IS_DIR)) return null;

        const now = Date.now();
        const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
        const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

        let costToday = 0, costWeek = 0;
        let found = false;

        try {
            const dir = Gio.File.new_for_path(projectsDir);
            this._walkJsonl(dir, (entry) => {
                const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
                const cost = entry.costUSD ?? entry.cost_usd ?? entry.cost ?? 0;
                if (cost > 0 && ts > sevenDaysAgo) {
                    costWeek += cost;
                    found = true;
                    if (ts > fiveHoursAgo) costToday += cost;
                }
            });
        } catch { /* best effort */ }

        return found ? { today: costToday, week: costWeek } : null;
    }

    _walkJsonl(dir, callback) {
        const enumerator = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null))) {
            const child = dir.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                try { this._walkJsonl(child, callback); } catch { /* skip */ }
            } else if (info.get_name().endsWith('.jsonl')) {
                try {
                    const [, bytes] = child.load_contents(null);
                    const text = new TextDecoder().decode(bytes);
                    for (const line of text.split('\n')) {
                        if (!line.trim()) continue;
                        try { callback(JSON.parse(line)); } catch { /* skip */ }
                    }
                } catch { /* skip */ }
            }
        }
    }
}
