import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import { ProviderBase, cliIsInstalled, readFileJson } from './base.js';

const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class GeminiProvider extends ProviderBase {
    constructor(settings) {
        super('gemini', 'Gemini');
        this._settings = settings;
        this._session = new Soup.Session({ timeout: 10 });
    }

    destroy() {
        try { this._session?.abort(); } catch { /* ignore */ }
        this._session = null;
        super.destroy();
    }

    _credsPath() {
        const envDir = GLib.getenv('GEMINI_CONFIG_DIR');
        const base = envDir || GLib.build_filenamev([GLib.get_home_dir(), '.gemini']);
        return GLib.build_filenamev([base, 'oauth_creds.json']);
    }

    _loadCreds() {
        const creds = readFileJson(this._credsPath());
        if (!creds?.access_token) return null;
        return creds;
    }

    _isTokenValid(creds) {
        if (!creds?.expiry_date) return true; // assume valid if no expiry
        // expiry_date is in milliseconds
        return creds.expiry_date > Date.now() + 30000;
    }

    // ── OAuth client credentials extraction ─────────────────────────────────
    // Mirrors CodexBar's approach: find the Gemini CLI binary, locate oauth2.js,
    // extract OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET via regex.

    _findGeminiCliPath() {
        const setting = this._settings.get_string('gemini-cli-path') || 'gemini';
        if (setting.startsWith('/')) return GLib.file_test(setting, GLib.FileTest.EXISTS) ? setting : null;
        return GLib.find_program_in_path(setting);
    }

    _resolveSymlink(path) {
        try {
            const f = Gio.File.new_for_path(path);
            return f.resolve_relative_path('').get_path() ?? path;
        } catch { return path; }
    }

    _extractOAuthCreds(geminiPath) {
        const real = this._resolveSymlink(geminiPath);
        const binDir = GLib.path_get_dirname(real);
        const baseDir = GLib.path_get_dirname(binDir);

        const oauthSubpath =
            'node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js';
        const coreDirect =
            'node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js';
        const oauthFile = 'dist/src/code_assist/oauth2.js';

        const candidates = [
            `${baseDir}/libexec/lib/${oauthSubpath}`,
            `${baseDir}/lib/${oauthSubpath}`,
            `${baseDir}/../gemini-cli-core/${oauthFile}`,
            `${baseDir}/${coreDirect}`,
            `${baseDir}/lib/${coreDirect}`,
        ];

        for (const p of candidates) {
            if (!GLib.file_test(p, GLib.FileTest.EXISTS)) continue;
            const [ok, bytes] = GLib.file_get_contents(p);
            if (!ok) continue;
            const text = new TextDecoder().decode(bytes);
            const idM  = text.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/);
            const secM = text.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/);
            if (idM && secM) return { clientId: idM[1], clientSecret: secM[1] };
        }
        return null;
    }

    async _refreshToken(creds) {
        const geminiPath = this._findGeminiCliPath();
        if (!geminiPath) throw new Error('Cannot refresh: gemini CLI not found');

        const oauthCreds = this._extractOAuthCreds(geminiPath);
        if (!oauthCreds) throw new Error('Cannot refresh: could not find Gemini CLI OAuth config');

        const body = [
            `client_id=${encodeURIComponent(oauthCreds.clientId)}`,
            `client_secret=${encodeURIComponent(oauthCreds.clientSecret)}`,
            `refresh_token=${encodeURIComponent(creds.refresh_token)}`,
            'grant_type=refresh_token',
        ].join('&');

        const msg = Soup.Message.new('POST', TOKEN_URL);
        msg.set_request_body_from_bytes(
            'application/x-www-form-urlencoded',
            new GLib.Bytes(new TextEncoder().encode(body))
        );

        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                try { resolve(sess.send_and_read_finish(res)); }
                catch (e) { reject(e); }
            });
        });

        if (msg.get_status() !== 200)
            throw new Error(`Token refresh failed: HTTP ${msg.get_status()}`);

        const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        if (!json.access_token) throw new Error('Token refresh: no access_token in response');

        // Persist the new token back to oauth_creds.json
        try {
            const updated = { ...creds, access_token: json.access_token };
            if (json.expires_in) updated.expiry_date = (Date.now() + json.expires_in * 1000);
            if (json.id_token)   updated.id_token = json.id_token;
            GLib.file_set_contents(this._credsPath(), JSON.stringify(updated, null, 2));
        } catch { /* non-fatal — token will work for this session */ }

        return json.access_token;
    }

    async detect() {
        const cliPath = this._settings.get_string('gemini-cli-path');
        const installed = cliIsInstalled(cliPath);
        const creds = this._loadCreds();
        const authenticated = !!creds;
        return { installed, authenticated };
    }

    async fetchQuota() {
        this._inFlight = true;
        try {
            const cliPath = this._settings.get_string('gemini-cli-path');
            const installed = cliIsInstalled(cliPath);
            if (!installed) return { installed: false, authenticated: false };

            let creds = this._loadCreds();
            if (!creds) {
                return { installed: true, authenticated: false, error: 'No credentials — run gemini once to authenticate' };
            }

            let token = creds.access_token;
            if (!this._isTokenValid(creds)) {
                if (!creds.refresh_token) {
                    return { installed: true, authenticated: false, error: 'Token expired — run gemini once to refresh' };
                }
                try {
                    token = await this._refreshToken(creds);
                } catch (e) {
                    return { installed: true, authenticated: false, error: `Token refresh failed: ${e.message}` };
                }
            }

            const result = await this._fetchQuotaApi(token);
            return { installed: true, authenticated: true, ...result };
        } catch (e) {
            return { installed: true, authenticated: true, error: e.message };
        } finally {
            this._inFlight = false;
        }
    }

    async _fetchQuotaApi(token) {
        const msg = Soup.Message.new('POST', QUOTA_URL);
        msg.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(new TextEncoder().encode('{}'))
        );
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        msg.request_headers.append('Content-Type', 'application/json');

        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                try { resolve(sess.send_and_read_finish(res)); }
                catch (e) { reject(e); }
            });
        });

        const status = msg.get_status();
        if (status === 401) return { authenticated: false, error: 'Token rejected — run gemini once to re-authenticate' };
        if (status !== 200) return { error: `Gemini quota API returned HTTP ${status}` };

        const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        return this._parseQuotaResponse(json);
    }

    _parseQuotaResponse(json) {
        // API response: { "buckets": [ { "remainingFraction": 0.75, "resetTime": "...", "modelId": "..." } ] }
        const buckets = json.buckets ?? json.quotaWindows ?? json.quotas ?? json.quota ?? json.resources ?? [];
        if (!Array.isArray(buckets) || buckets.length === 0) {
            return {};
        }

        // Group by modelId, keep lowest remainingFraction per model
        const modelMap = {};
        for (const b of buckets) {
            if (b.modelId === undefined || b.modelId === null) continue;
            const frac = b.remainingFraction ?? b.remaining_fraction;
            if (frac === undefined || frac === null) continue;
            if (!(b.modelId in modelMap) || frac < modelMap[b.modelId].frac) {
                modelMap[b.modelId] = { frac, resetTime: b.resetTime ?? b.reset_time ?? null };
            }
        }

        const entries = Object.entries(modelMap);
        if (entries.length === 0) {
            return {};
        }

        // Sort: pro models primary, flash secondary, rest tertiary
        const isPro   = id => id.toLowerCase().includes('pro');
        const isFlash = id => id.toLowerCase().includes('flash') && !id.toLowerCase().includes('flash-lite');

        const proEntries   = entries.filter(([id]) => isPro(id));
        const flashEntries = entries.filter(([id]) => isFlash(id) && !isPro(id));
        const otherEntries = entries.filter(([id]) => !isPro(id) && !isFlash(id));

        const pickLowest = (list) => list.length === 0 ? null
            : list.reduce((a, b) => b[1].frac < a[1].frac ? b : a);

        const primary   = pickLowest(proEntries)   ?? pickLowest(otherEntries);
        const secondary = pickLowest(flashEntries);

        if (!primary) return {};

        const makeWindow = ([modelId, { frac, resetTime }], label) => ({
            remaining: Math.max(0, Math.min(1, frac)),
            resetAt: resetTime ? new Date(resetTime) : null,
            label: label ?? modelId,
        });

        const result = {
            session: makeWindow(primary, proEntries.length ? 'Pro (daily)' : 'Daily'),
        };
        if (secondary) {
            result.weekly = makeWindow(secondary, 'Flash (daily)');
        }
        return result;
    }
}
