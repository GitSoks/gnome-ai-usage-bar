import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { ProviderBase, cliIsInstalled } from './base.js';

export class OpenCodeProvider extends ProviderBase {
    constructor(settings) {
        super('opencode', 'OpenCode');
        this._settings = settings;
    }

    _dbPath() {
        return GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'opencode', 'opencode.db']);
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
            if (!GLib.file_test(dbPath, GLib.FileTest.EXISTS)) {
                return { installed: true, authenticated: false, error: 'No OpenCode database found' };
            }

            const stats = await this._queryDb(dbPath);
            return { installed: true, authenticated: true, ...stats };
        } catch (e) {
            return { installed: true, authenticated: true, error: e.message };
        } finally {
            this._inFlight = false;
        }
    }

    async _queryDb(dbPath) {
        const nowMs = Date.now();
        const fiveHoursAgoMs = nowMs - 5 * 60 * 60 * 1000;
        const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;

        // Query stats for 5h and 7d windows using sqlite3 CLI
        const query = `
SELECT
    SUM(CASE WHEN p.time_created >= ${fiveHoursAgoMs} THEN CAST(json_extract(p.data,'$.cost') AS REAL) ELSE 0 END) AS cost_5h,
    SUM(CASE WHEN p.time_created >= ${sevenDaysAgoMs} THEN CAST(json_extract(p.data,'$.cost') AS REAL) ELSE 0 END) AS cost_7d,
    SUM(CASE WHEN p.time_created >= ${fiveHoursAgoMs} THEN CAST(json_extract(json_extract(p.data,'$.tokens'),'$.input') AS INTEGER) ELSE 0 END) AS tokens_in_5h,
    SUM(CASE WHEN p.time_created >= ${fiveHoursAgoMs} THEN CAST(json_extract(json_extract(p.data,'$.tokens'),'$.output') AS INTEGER) ELSE 0 END) AS tokens_out_5h,
    SUM(CASE WHEN p.time_created >= ${sevenDaysAgoMs} THEN CAST(json_extract(json_extract(p.data,'$.tokens'),'$.total') AS INTEGER) ELSE 0 END) AS tokens_total_7d,
    COUNT(CASE WHEN p.time_created >= ${sevenDaysAgoMs} AND CAST(json_extract(p.data,'$.cost') AS REAL) > 0 THEN 1 END) AS calls_7d
FROM part p
WHERE json_extract(p.data,'$.cost') IS NOT NULL;
`.trim();

        const output = await new Promise((resolve, reject) => {
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
                        if (!p.get_successful()) {
                            reject(new Error(stderr?.trim() || 'sqlite3 failed'));
                        } else {
                            resolve(stdout?.trim() || '');
                        }
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

        return this._parseDbOutput(output);
    }

    _parseDbOutput(output) {
        if (!output) return { cost: { today: 0, week: 0 }, tokens: {} };
        const parts = output.split('|');
        if (parts.length < 6) return { error: 'Unexpected sqlite3 output', cost: { today: 0, week: 0 } };

        const cost5h = parseFloat(parts[0]) || 0;
        const cost7d = parseFloat(parts[1]) || 0;
        const tokIn5h = parseInt(parts[2]) || 0;
        const tokOut5h = parseInt(parts[3]) || 0;
        const tok7d = parseInt(parts[4]) || 0;
        const calls7d = parseInt(parts[5]) || 0;

        return {
            // OpenCode is cost-based, no hard quota — show cost data instead of bars
            cost: { today: cost5h, week: cost7d },
            tokens: { input5h: tokIn5h, output5h: tokOut5h, total7d: tok7d },
            calls7d,
        };
    }
}
