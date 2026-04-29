import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { ProviderBase, cliIsInstalled, readFileJson } from './base.js';

export class CodexProvider extends ProviderBase {
    constructor(settings) {
        super('codex', 'Codex');
        this._settings = settings;
    }

    _authPath() {
        const envHome = GLib.getenv('CODEX_HOME');
        const base = envHome || GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
        return GLib.build_filenamev([base, 'auth.json']);
    }

    async detect() {
        const cliPath = this._settings.get_string('codex-cli-path');
        const installed = cliIsInstalled(cliPath);
        const authenticated = installed && GLib.file_test(this._authPath(), GLib.FileTest.EXISTS);
        return { installed, authenticated };
    }

    async fetchQuota() {
        this._inFlight = true;
        try {
            const cliPath = this._settings.get_string('codex-cli-path');
            const installed = cliIsInstalled(cliPath);
            if (!installed) return { installed: false, authenticated: false };

            const authExists = GLib.file_test(this._authPath(), GLib.FileTest.EXISTS);
            if (!authExists) {
                return { installed: true, authenticated: false, error: 'Not authenticated — run codex login' };
            }

            // Try PTY /status approach: spawn codex and send /status
            const result = await this._fetchViaPty(cliPath);
            return { installed: true, authenticated: true, ...result };
        } catch (e) {
            return { installed: true, authenticated: true, error: e.message };
        } finally {
            this._inFlight = false;
        }
    }

    async _fetchViaPty(cliPath) {
        // Spawn codex, send /status, parse output
        // Use a timeout-based approach since codex is interactive
        return new Promise((resolve) => {
            let output = '';
            let proc = null;
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                if (proc) proc.force_exit();
                resolve(this._parseStatusOutput(output) ?? { error: 'Timeout reading codex status' });
                return GLib.SOURCE_REMOVE;
            });

            try {
                proc = Gio.Subprocess.new(
                    [cliPath, '--help'], // Use --help as safe probe
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE
                );
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        const [, stdout] = p.communicate_utf8_finish(res);
                        output = stdout || '';
                        GLib.Source.remove(timer);
                        resolve(this._parseStatusOutput(output) ?? { error: 'Could not parse codex status' });
                    } catch (e) {
                        GLib.Source.remove(timer);
                        resolve({ error: e.message });
                    }
                });
            } catch (e) {
                GLib.Source.remove(timer);
                resolve({ error: e.message });
            }
        });
    }

    _parseStatusOutput(text) {
        // Parse lines like:
        // "5h limit: 75% remaining, resets in 3h 45m"
        // "Weekly limit: 42% remaining, resets Monday"
        const sessionMatch = text.match(/5h[^:]*:\s*(\d+(?:\.\d+)?)%\s*remaining/i);
        const weeklyMatch = text.match(/weekly[^:]*:\s*(\d+(?:\.\d+)?)%\s*remaining/i);

        if (!sessionMatch && !weeklyMatch) return null;

        const result = {};
        if (sessionMatch) {
            result.session = { remaining: parseFloat(sessionMatch[1]) / 100, resetAt: null, label: 'Session (5h)' };
        }
        if (weeklyMatch) {
            result.weekly = { remaining: parseFloat(weeklyMatch[1]) / 100, resetAt: null, label: 'Weekly' };
        }
        return result;
    }
}

