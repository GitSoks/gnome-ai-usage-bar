import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import { ProviderBase, cliIsInstalled } from './base.js';

const GO_SCRAPE_URL = 'https://opencode.ai/workspace/{workspaceId}/go';

// Auth cookies expire within 24h; re-discover every 25 min so we always have a fresh one.
// Re-discovery runs the Python browser-extraction script, so we cache the result in memory.
const CRED_CACHE_TTL_MS = 25 * 60 * 1000;

export class OpenCodeProvider extends ProviderBase {
    constructor(settings, extPath) {
        super('opencode', 'OpenCode');
        this._settings = settings;
        this._extPath = extPath;
        this._session = new Soup.Session({ timeout: 10 });
        this._credCache = null; // { workspaceId, authCookie, fetchedAt }
    }

    destroy() {
        try { this._session?.abort(); } catch { /* ignore */ }
        this._session = null;
        this._credCache = null;
        super.destroy();
    }

    _dbPath() {
        return GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'opencode', 'opencode.db']);
    }

    _extensionPath() {
        return this._extPath || GLib.get_home_dir() + '/.local/share/gnome-shell/extensions/ai-usage-bar@sokolowski.tech';
    }

    async detect() {
        const cliPath = this._settings.get_string('opencode-cli-path');
        const installed = cliIsInstalled(cliPath);
        const authenticated = installed && GLib.file_test(this._dbPath(), GLib.FileTest.EXISTS);
        return { installed, authenticated };
    }

    async fetchQuota() {
        this._inFlight = true;
        try {
            const cliPath = this._settings.get_string('opencode-cli-path');
            const installed = cliIsInstalled(cliPath);
            if (!installed) return { installed: false, authenticated: false };

            const dbPath = this._dbPath();
            if (!GLib.file_test(dbPath, GLib.FileTest.EXISTS))
                return { installed: true, authenticated: false, error: 'No OpenCode database found' };

            const mode = this._settings.get_string('opencode-display-mode');
            const goMode = mode === 'go-subscription';

            // ── Try web scraping for Go subscription mode ──────────────────────
            if (goMode && this._settings.get_boolean('opencode-go-auto-fetch')) {
                const creds = await this._getCredentials();

                if (creds?.workspaceId && creds?.authCookie) {
                    try {
                        const scrapeResult = await this._scrapeGoPage(creds.workspaceId, creds.authCookie);
                        if (scrapeResult) {
                            const localStats = await this._queryDb(dbPath, false);
                            return {
                                installed: true,
                                authenticated: true,
                                ...scrapeResult,
                                ...(localStats?.cost ? { cost: localStats.cost } : {}),
                            };
                        }
                    } catch (scrapeErr) {
                        // Auth cookie expired: clear cache + saved cookie, then retry once with fresh credentials
                        if (scrapeErr.message.includes('Auth expired')) {
                            this._credCache = null;
                            // Clear the saved auth cookie so re-discovery can fetch a fresh one from the browser
                            if (this._settings.get_string('opencode-auth-cookie'))
                                this._settings.set_string('opencode-auth-cookie', '');

                            const freshCreds = await this._getCredentials();
                            if (freshCreds?.authCookie && freshCreds.authCookie !== creds.authCookie) {
                                try {
                                    const retryResult = await this._scrapeGoPage(freshCreds.workspaceId, freshCreds.authCookie);
                                    if (retryResult) {
                                        const localStats = await this._queryDb(dbPath, false);
                                        return {
                                            installed: true,
                                            authenticated: true,
                                            ...retryResult,
                                            ...(localStats?.cost ? { cost: localStats.cost } : {}),
                                        };
                                    }
                                } catch { /* fall through to local DB */ }
                            }
                        }

                        // Scraping failed — fall back to local DB but preserve the error
                        const localResult = await this._queryDb(dbPath, true);
                        return {
                            installed: true,
                            authenticated: true,
                            error: `Web: ${scrapeErr.message}`,
                            ...localResult,
                        };
                    }
                }
            }

            // ── Fall back to local DB ──────────────────────────────────────────
            const stats = await this._queryDb(dbPath, goMode);
            return { installed: true, authenticated: true, ...stats };
        } catch (e) {
            return { installed: true, authenticated: true, error: e.message };
        } finally {
            this._inFlight = false;
        }
    }

    // ── Credential resolution: settings overrides → in-memory cache → browser discovery ──

    async _getCredentials() {
        const storedWorkspaceId = this._settings.get_string('opencode-workspace-id');
        const storedAuthCookie  = this._settings.get_string('opencode-auth-cookie');

        // User has explicitly configured both — use them as-is, skip discovery
        if (storedWorkspaceId && storedAuthCookie)
            return { workspaceId: storedWorkspaceId, authCookie: storedAuthCookie };

        // Use in-memory cache if still within TTL
        const now = Date.now();
        if (this._credCache && (now - this._credCache.fetchedAt) < CRED_CACHE_TTL_MS) {
            return {
                workspaceId: storedWorkspaceId || this._credCache.workspaceId,
                authCookie:  storedAuthCookie  || this._credCache.authCookie,
            };
        }

        // Discover fresh from browser
        const discovered = await this._discoverCredentials();
        if (discovered) {
            this._credCache = { ...discovered, fetchedAt: now };
            // Persist workspace ID only — it's stable and useful to show in prefs.
            // Auth cookie is intentionally NOT saved to settings: it expires within 24h
            // and must be re-discovered from the browser on each cache miss.
            if (!storedWorkspaceId && discovered.workspaceId)
                this._settings.set_string('opencode-workspace-id', discovered.workspaceId);
        }

        return {
            workspaceId: storedWorkspaceId || discovered?.workspaceId || null,
            authCookie:  storedAuthCookie  || discovered?.authCookie  || null,
        };
    }

    // ── Auto-discover credentials from browser ────────────────────────────────

    async _discoverCredentials() {
        try {
            const extPath = this._extensionPath();
            const venvPython = GLib.build_filenamev([extPath, '.venv', 'bin', 'python3']);
            const scriptPath = GLib.build_filenamev([extPath, 'lib', 'extract_opencode_cookie.py']);

            const pythonPath = GLib.file_test(venvPython, GLib.FileTest.IS_EXECUTABLE)
                ? venvPython
                : 'python3';

            if (!GLib.file_test(scriptPath, GLib.FileTest.EXISTS))
                return null;

            const proc = Gio.Subprocess.new(
                [pythonPath, scriptPath],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            const [, stdout, stderr] = await new Promise((resolve, reject) => {
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        resolve(p.communicate_utf8_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            if (!proc.get_successful()) {
                console.error('AIUsageBar: cookie extraction failed:', stderr?.trim());
                return null;
            }

            const lines = stdout?.trim().split('\n') || [];
            let workspaceId = null;
            let authCookie  = null;

            for (const line of lines) {
                if (line.startsWith('WORKSPACE:'))
                    workspaceId = line.slice('WORKSPACE:'.length);
                else if (line.startsWith('COOKIE:'))
                    authCookie = line.slice('COOKIE:'.length);
            }

            if (workspaceId || authCookie)
                return { workspaceId, authCookie };
            return null;
        } catch (e) {
            console.error('AIUsageBar: credential discovery error:', e.message);
            return null;
        }
    }

    // ── OpenCode Go console scraping ──────────────────────────────────────────

    async _scrapeGoPage(workspaceId, authCookie) {
        const cookieHeader = authCookie.startsWith('auth=') ? authCookie : `auth=${authCookie}`;
        const url = GO_SCRAPE_URL.replace('{workspaceId}', workspaceId);

        const msg = Soup.Message.new('GET', url);
        msg.request_headers.append('Cookie', cookieHeader);
        msg.request_headers.append('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36');
        msg.request_headers.append('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
        msg.request_headers.append('Accept-Language', 'en-US,en;q=0.9');

        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                try { resolve(sess.send_and_read_finish(res)); }
                catch (e) { reject(e); }
            });
        });

        const status = msg.get_status();
        if (status === 401) throw new Error('Auth expired — re-copy cookie from browser');
        if (status === 404) throw new Error('Workspace not found');
        if (status !== 200) throw new Error(`HTTP ${status}`);

        const html = new TextDecoder().decode(bytes.get_data());
        return this._parseGoHtml(html);
    }

    _parseGoHtml(html) {
        // SolidJS SSR hydration format:
        // rollingUsage:$R[28]={status:"ok",resetInSec:799,usagePercent:23}
        // Monthly may use resetDate (ISO string) or resetTimestamp (Unix seconds) instead of resetInSec
        const extractWindow = (name) => {
            const makePattern = (prefix) =>
                new RegExp(`${prefix}\\{([^}]{0,500})\\}`);

            let raw = null;
            for (const prefix of [`${name}:\\\$R\\[\\d+\\]=`, `${name}=`]) {
                const m = makePattern(prefix).exec(html);
                if (m) { raw = m[1]; break; }
            }
            if (!raw) return null;

            const getField = (key) => {
                const m = new RegExp(`${key}:([^,}]+)`).exec(raw);
                return m ? m[1].replace(/^"|"$/g, '').trim() : null;
            };

            const usagePctStr = getField('usagePercent');
            if (usagePctStr === null) return null;

            const usagePercent = parseInt(usagePctStr, 10);
            const remaining = Math.max(0, Math.min(1, 1 - usagePercent / 100));

            let resetAt = null;

            const resetInSecStr = getField('resetInSec');
            if (resetInSecStr !== null) {
                const secs = parseInt(resetInSecStr, 10);
                if (secs > 0) resetAt = new Date(Date.now() + secs * 1000);
            }

            if (!resetAt) {
                const dateStr = getField('resetDate');
                if (dateStr) {
                    const d = new Date(dateStr);
                    if (!isNaN(d)) resetAt = d;
                }
            }

            if (!resetAt) {
                const tsStr = getField('resetTimestamp');
                if (tsStr !== null) {
                    const ts = parseInt(tsStr, 10);
                    if (ts > 0) resetAt = new Date(ts * 1000);
                }
            }

            return { remaining, resetAt };
        };

        const rolling = extractWindow('rollingUsage');
        const weekly  = extractWindow('weeklyUsage');
        const monthly = extractWindow('monthlyUsage');

        if (!rolling && !weekly && !monthly)
            throw new Error('Could not find quota usage data in HTML');

        if (monthly && !monthly.resetAt) {
            const now = new Date();
            monthly.resetAt = new Date(Date.UTC(
                now.getUTCMonth() === 11 ? now.getUTCFullYear() + 1 : now.getUTCFullYear(),
                now.getUTCMonth() === 11 ? 0 : now.getUTCMonth() + 1,
                1
            ));
        }

        const result = {};
        if (rolling) result.session = { ...rolling, label: '5h' };
        if (weekly)  result.weekly  = { ...weekly,  label: 'Weekly' };
        if (monthly) result.monthly = { ...monthly, label: 'Monthly' };

        return result;
    }

    // ── Cost mode (all providers, rolling windows) ────────────────────────────

    async _queryCostMode(dbPath) {
        const nowMs   = Date.now();
        const t5h     = nowMs - 5 * 3600 * 1000;
        const t7d     = nowMs - 7 * 24 * 3600 * 1000;

        const query = `
SELECT
    SUM(CASE WHEN p.time_created >= ${t5h} THEN CAST(json_extract(p.data,'$.cost') AS REAL) ELSE 0 END) AS cost_5h,
    SUM(CASE WHEN p.time_created >= ${t7d} THEN CAST(json_extract(p.data,'$.cost') AS REAL) ELSE 0 END) AS cost_7d,
    SUM(CASE WHEN p.time_created >= ${t5h} THEN CAST(json_extract(json_extract(p.data,'$.tokens'),'$.input') AS INTEGER) ELSE 0 END) AS tok_in_5h,
    SUM(CASE WHEN p.time_created >= ${t5h} THEN CAST(json_extract(json_extract(p.data,'$.tokens'),'$.output') AS INTEGER) ELSE 0 END) AS tok_out_5h,
    SUM(CASE WHEN p.time_created >= ${t7d} THEN CAST(json_extract(json_extract(p.data,'$.tokens'),'$.total') AS INTEGER) ELSE 0 END) AS tok_total_7d,
    COUNT(CASE WHEN p.time_created >= ${t7d} AND CAST(json_extract(p.data,'$.cost') AS REAL) > 0 THEN 1 END) AS calls_7d
FROM part p
WHERE json_extract(p.data,'$.cost') IS NOT NULL;`.trim();

        const out = await this._runSqlite(dbPath, query);
        if (!out) return { cost: { today: 0, week: 0 }, tokens: {} };
        const p = out.split('|');
        if (p.length < 6) return { error: 'Unexpected sqlite3 output', cost: { today: 0, week: 0 } };
        return {
            cost: { today: parseFloat(p[0]) || 0, week: parseFloat(p[1]) || 0 },
            tokens: { input5h: parseInt(p[2]) || 0, output5h: parseInt(p[3]) || 0, total7d: parseInt(p[4]) || 0 },
            calls7d: parseInt(p[5]) || 0,
        };
    }

    // ── Go subscription mode (opencode-go provider only, 5h/7d/30d) ──────────

    async _queryGoMode(dbPath) {
        const nowMs = Date.now();
        const t5h   = nowMs -  5 * 3600 * 1000;
        const t7d   = nowMs -  7 * 24 * 3600 * 1000;
        const t30d  = nowMs - 30 * 24 * 3600 * 1000;

        const query = `
WITH go_asst AS (
    SELECT am.id, json_extract(am.data,'$.parentID') AS parent_id
    FROM message am
    JOIN message um ON json_extract(am.data,'$.parentID') = um.id
    WHERE json_extract(am.data,'$.role') = 'assistant'
      AND json_extract(um.data,'$.model.providerID') = 'opencode-go'
)
SELECT
    SUM(CASE WHEN p.time_created >= ${t5h}  THEN CAST(json_extract(p.data,'$.tokens.input')  AS INTEGER) ELSE 0 END) AS tok_in_5h,
    SUM(CASE WHEN p.time_created >= ${t5h}  THEN CAST(json_extract(p.data,'$.tokens.output') AS INTEGER) ELSE 0 END) AS tok_out_5h,
    SUM(CASE WHEN p.time_created >= ${t5h}  THEN CAST(json_extract(p.data,'$.cost') AS REAL) ELSE 0 END) AS cost_5h,
    COUNT(DISTINCT CASE WHEN p.time_created >= ${t5h}  THEN ga.parent_id END) AS calls_5h,
    SUM(CASE WHEN p.time_created >= ${t7d}  THEN CAST(json_extract(p.data,'$.tokens.input')  AS INTEGER) ELSE 0 END) AS tok_in_7d,
    SUM(CASE WHEN p.time_created >= ${t7d}  THEN CAST(json_extract(p.data,'$.tokens.output') AS INTEGER) ELSE 0 END) AS tok_out_7d,
    SUM(CASE WHEN p.time_created >= ${t7d}  THEN CAST(json_extract(p.data,'$.cost') AS REAL) ELSE 0 END) AS cost_7d,
    COUNT(DISTINCT CASE WHEN p.time_created >= ${t7d}  THEN ga.parent_id END) AS calls_7d,
    SUM(CASE WHEN p.time_created >= ${t30d} THEN CAST(json_extract(p.data,'$.tokens.input')  AS INTEGER) ELSE 0 END) AS tok_in_30d,
    SUM(CASE WHEN p.time_created >= ${t30d} THEN CAST(json_extract(p.data,'$.tokens.output') AS INTEGER) ELSE 0 END) AS tok_out_30d,
    SUM(CASE WHEN p.time_created >= ${t30d} THEN CAST(json_extract(p.data,'$.cost') AS REAL) ELSE 0 END) AS cost_30d,
    COUNT(DISTINCT CASE WHEN p.time_created >= ${t30d} THEN ga.parent_id END) AS calls_30d
FROM part p
JOIN go_asst ga ON p.message_id = ga.id
WHERE json_extract(p.data,'$.type') = 'step-finish'
  AND p.time_created >= ${t30d};`.trim();

        const out = await this._runSqlite(dbPath, query);
        if (!out) return this._emptyGoResult();
        const parts = out.split('|');
        if (parts.length < 12) return { error: 'Unexpected sqlite3 output' };

        const v = parts.map(Number);
        return this._buildGoResult({
            tokIn5h: v[0]|0, tokOut5h: v[1]|0, cost5h: v[2],  calls5h: v[3]|0,
            tokIn7d: v[4]|0, tokOut7d: v[5]|0, cost7d: v[6],  calls7d: v[7]|0,
            tokIn30d:v[8]|0, tokOut30d:v[9]|0, cost30d:v[10], calls30d:v[11]|0,
        });
    }

    _emptyGoResult() {
        const mk = (label) => ({ remaining: null, resetAt: null, label });
        return {
            session: mk('5h (0 calls)'),
            weekly:  mk('Weekly (0 calls)'),
            monthly: mk('Monthly (0 calls)'),
        };
    }

    _buildGoResult({ tokIn5h, tokOut5h, cost5h, calls5h,
                     tokIn7d, tokOut7d, cost7d, calls7d,
                     tokIn30d, tokOut30d, cost30d, calls30d }) {
        const sessionQ = this._settings.get_int('opencode-go-session-quota');
        const weeklyQ  = this._settings.get_int('opencode-go-weekly-quota');
        const monthlyQ = this._settings.get_int('opencode-go-monthly-quota');

        const fmtCost = (c) => c > 0 ? ` · $${c.toFixed(2)}` : '';
        const fmtK    = (n) => n >= 1000 ? `${(n/1000).toFixed(0)}k` : `${n}`;

        const mkWindow = (calls, tokIn, tokOut, cost, quota, winLabel) => {
            const remaining = quota > 0
                ? Math.max(0, Math.min(1, (quota - calls) / quota))
                : null;
            const detail = quota > 0
                ? `${quota - calls}/${quota} left`
                : `${calls} calls · ${fmtK(tokIn + tokOut)} tok${fmtCost(cost)}`;
            return { remaining, resetAt: null, label: `${winLabel} (${detail})` };
        };

        return {
            session: mkWindow(calls5h,  tokIn5h,  tokOut5h,  cost5h,  sessionQ, '5h'),
            weekly:  mkWindow(calls7d,  tokIn7d,  tokOut7d,  cost7d,  weeklyQ,  'Weekly'),
            monthly: mkWindow(calls30d, tokIn30d, tokOut30d, cost30d, monthlyQ, 'Monthly'),
        };
    }

    // ── Shared SQLite runner ──────────────────────────────────────────────────

    async _queryDb(dbPath, goMode) {
        return goMode ? this._queryGoMode(dbPath) : this._queryCostMode(dbPath);
    }

    _runSqlite(dbPath, query) {
        return new Promise((resolve, reject) => {
            let proc = null;
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
                if (proc) proc.force_exit();
                reject(new Error('sqlite3 query timed out'));
                return GLib.SOURCE_REMOVE;
            });
            try {
                proc = Gio.Subprocess.new(
                    ['sqlite3', '-separator', '|', dbPath, query],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        const [, stdout, stderr] = p.communicate_utf8_finish(res);
                        GLib.Source.remove(timer);
                        if (!p.get_successful())
                            reject(new Error(stderr?.trim() || 'sqlite3 failed'));
                        else
                            resolve(stdout?.trim() || '');
                    } catch (e) {
                        GLib.Source.remove(timer);
                        reject(e);
                    }
                });
            } catch (e) {
                GLib.Source.remove(timer);
                reject(e);
            }
        });
    }
}
