import GLib from 'gi://GLib';

// ── Shared constants ───────────────────────────────────────────────────────────

export const STATE = { OK: 'ok', WARN: 'warn', CRIT: 'crit', ERROR: 'error', UNKNOWN: 'unknown' };

// ── Utility helpers ────────────────────────────────────────────────────────────

export function cliIsInstalled(path) {
    if (!path || path.trim() === '') return false;
    if (path.startsWith('/')) return GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE);
    return GLib.find_program_in_path(path) !== null;
}

export function readFileJson(filePath) {
    try {
        const [ok, contents] = GLib.file_get_contents(filePath);
        if (!ok) return null;
        return JSON.parse(new TextDecoder().decode(contents));
    } catch {
        return null;
    }
}

export function expandHome(path) {
    if (path.startsWith('~/')) return GLib.get_home_dir() + path.slice(1);
    return path;
}


// ── Base class ─────────────────────────────────────────────────────────────────

export class ProviderBase {
    constructor(id, displayName) {
        this.id = id;
        this.displayName = displayName;
        this._inFlight = false;
    }

    /** Returns { installed, authenticated, error? } */
    async detect() { return { installed: false, authenticated: false }; }

    /**
     * Returns QuotaResult:
     * {
     *   session?: { remaining: 0-1, resetAt: Date|null, label: string },
     *   weekly?:  { remaining: 0-1, resetAt: Date|null, label: string },
     *   cost?:    { today: number, week: number },   // USD, for cost-only providers
     *   installed: bool, authenticated: bool, error?: string
     * }
     */
    async fetchQuota() {
        return { installed: false, authenticated: false, error: 'Not implemented' };
    }

    get inFlight() { return this._inFlight; }
}
