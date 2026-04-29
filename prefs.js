/**
 * AI Usage Bar — prefs.js
 * Three-page preferences: Providers, Display, About.
 */

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import { ClaudeProvider }    from './lib/providers/claude.js';
import { GeminiProvider }    from './lib/providers/gemini.js';
import { CodexProvider }     from './lib/providers/codex.js';
import { CopilotProvider }   from './lib/providers/copilot.js';
import { OpenCodeProvider }  from './lib/providers/opencode.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function cliIsInstalled(path) {
    if (!path || path.trim() === '') return false;
    if (path.startsWith('/')) return GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE);
    return GLib.find_program_in_path(path) !== null;
}

function fileExists(path) {
    if (!path) return false;
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

function makeEntry(title, settings, key, placeholder = '') {
    const row = new Adw.EntryRow({ title });
    row.set_text(settings.get_string(key));
    row.connect('notify::text', () => settings.set_string(key, row.get_text()));
    return row;
}

function makeSwitchRow(title, subtitle, settings, key) {
    const row = new Adw.SwitchRow({ title, subtitle });
    row.set_active(settings.get_boolean(key));
    row.connect('notify::active', () => settings.set_boolean(key, row.get_active()));
    return row;
}

function makeSpinRow(title, subtitle, settings, key, min, max, step = 1) {
    const adj = new Gtk.Adjustment({ lower: min, upper: max, step_increment: step });
    const row = new Adw.SpinRow({ title, subtitle, adjustment: adj });
    row.set_value(settings.get_int(key));
    row.connect('notify::value', () => settings.set_int(key, row.get_value()));
    return row;
}

function makeDoubleSpinRow(title, subtitle, settings, key, min, max, step = 0.5, digits = 2) {
    const adj = new Gtk.Adjustment({ lower: min, upper: max, step_increment: step });
    const row = new Adw.SpinRow({ title, subtitle, adjustment: adj, digits });
    row.set_value(settings.get_double(key));
    row.connect('notify::value', () => settings.set_double(key, row.get_value()));
    return row;
}

// ── Provider config data ───────────────────────────────────────────────────────

const PROVIDERS = [
    {
        id: 'claude',
        name: 'Claude',
        description: 'Anthropic Claude (claude CLI)',
        cliKey: 'claude-cli-path',
        cliDefault: 'claude',
        credsPathFn: (settings) => {
            const override = settings.get_string('claude-config-dir');
            const base = override?.trim() || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
            return GLib.build_filenamev([base, '.credentials.json']);
        },
        extraRows: (expander, settings) => {
            expander.add_row(makeEntry('Config directory (override)', settings, 'claude-config-dir'));
        },
    },
    {
        id: 'gemini',
        name: 'Gemini',
        description: 'Google Gemini CLI',
        cliKey: 'gemini-cli-path',
        cliDefault: 'gemini',
        credsPathFn: () => {
            const envDir = GLib.getenv('GEMINI_CONFIG_DIR');
            const base = envDir || GLib.build_filenamev([GLib.get_home_dir(), '.gemini']);
            return GLib.build_filenamev([base, 'oauth_creds.json']);
        },
        extraRows: null,
    },
    {
        id: 'codex',
        name: 'Codex',
        description: 'OpenAI Codex CLI',
        cliKey: 'codex-cli-path',
        cliDefault: 'codex',
        credsPathFn: () => {
            const envHome = GLib.getenv('CODEX_HOME');
            const base = envHome || GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
            return GLib.build_filenamev([base, 'auth.json']);
        },
        extraRows: null,
    },
    {
        id: 'copilot',
        name: 'Copilot',
        description: 'GitHub Copilot CLI',
        cliKey: 'copilot-cli-path',
        cliDefault: 'copilot',
        credsPathFn: () => GLib.build_filenamev([GLib.get_home_dir(), '.config', 'gh', 'hosts.yml']),
        extraRows: null,
    },
    {
        id: 'opencode',
        name: 'OpenCode',
        description: 'OpenCode CLI (cost-based, no quota limit)',
        cliKey: 'opencode-cli-path',
        cliDefault: 'opencode',
        credsPathFn: () => GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'opencode', 'opencode.db']),
        extraRows: (expander, settings) => {
            expander.add_row(makeDoubleSpinRow(
                '5-hour budget (USD)',
                'Max spend for the 5h window — 0 shows raw cost only',
                settings, 'opencode-budget-5h', 0.0, 1000.0, 0.5
            ));
            expander.add_row(makeDoubleSpinRow(
                '7-day budget (USD)',
                'Max spend for the 7-day window — 0 shows raw cost only',
                settings, 'opencode-budget-7d', 0.0, 1000.0, 1.0
            ));
        },
    },
];

// ── Prefs window ───────────────────────────────────────────────────────────────

export default class AIUsageBarPrefs extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(680, 720);

        window.add(this._buildProvidersPage(settings));
        window.add(this._buildDisplayPage(settings));
        window.add(this._buildAboutPage());
    }

    // ── Direct provider fetching (runs in prefs process) ──────────────────────

    async _fetchAllProviders(settings) {
        const enabled = settings.get_strv('enabled-providers');
        const providers = [
            new ClaudeProvider(settings),
            new GeminiProvider(settings),
            new CodexProvider(settings),
            new CopilotProvider(settings),
            new OpenCodeProvider(settings),
        ].filter(p => enabled.includes(p.id));

        // Load existing cache so we keep data for providers we don't refresh
        let cache = {};
        try { cache = JSON.parse(settings.get_string('cached-quota-json') || '{}'); } catch { /* ok */ }

        await Promise.all(providers.map(async p => {
            try {
                const result = await p.fetchQuota();
                cache[p.id] = { ...result, _ts: Date.now() };
            } catch (e) {
                cache[p.id] = { installed: true, authenticated: false, error: e.message, _ts: Date.now() };
            }
        }));

        return cache;
    }

    // ── Current usage group ────────────────────────────────────────────────────

    _buildUsageGroup(settings) {
        const PROVIDER_IDS    = ['claude', 'gemini', 'codex', 'copilot', 'opencode'];
        const PROVIDER_NAMES  = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex', copilot: 'Copilot', opencode: 'OpenCode' };

        const group = new Adw.PreferencesGroup({
            title: 'Live Status',
            description: 'Last-fetched quota for each provider. Click Refresh to update now.',
        });

        // Refresh button row
        const refreshRow = new Adw.ActionRow({
            title: 'Fetch latest quota',
            activatable: false,
        });
        const refreshBtn = new Gtk.Button({
            label: '↻  Refresh Now',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action', 'pill'],
        });
        refreshRow.add_suffix(refreshBtn);
        group.add(refreshRow);

        // Per-provider rows
        const providerRows = {};
        PROVIDER_IDS.forEach(id => {
            const row = new Adw.ActionRow({ title: PROVIDER_NAMES[id], activatable: false });
            const iconPath = `${this.path}/icons/${id}-symbolic.svg`;
            if (GLib.file_test(iconPath, GLib.FileTest.EXISTS)) {
                const gicon = Gio.FileIcon.new(Gio.File.new_for_path(iconPath));
                const img = new Gtk.Image({ gicon, pixel_size: 20, valign: Gtk.Align.CENTER });
                row.add_prefix(img);
            }
            providerRows[id] = row;
            group.add(row);
        });

        // Populate rows from cached JSON
        const updateRows = () => {
            let cached = {};
            try { cached = JSON.parse(settings.get_string('cached-quota-json') || '{}'); } catch { /* ok */ }

            PROVIDER_IDS.forEach(id => {
                const data = cached[id];
                const row  = providerRows[id];
                if (!data) {
                    row.subtitle = 'No data yet';
                } else if (!data.installed) {
                    row.subtitle = 'Not installed';
                } else if (!data.authenticated) {
                    row.subtitle = 'Not authenticated';
                } else if (data.error && !data.session && !data.weekly && !data.cost) {
                    row.subtitle = `Error: ${data.error}`;
                } else {
                    const parts = [];
                    if (data.session) parts.push(`Session: ${Math.round(data.session.remaining * 100)}%`);
                    if (data.weekly)  parts.push(`Weekly: ${Math.round(data.weekly.remaining * 100)}%`);
                    if (data.cost)    parts.push(`Cost/wk: $${(data.cost.week ?? 0).toFixed(3)}`);
                    if (data._ts) {
                        const s = Math.floor((Date.now() - data._ts) / 1000);
                        const age = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
                        parts.push(age);
                    }
                    row.subtitle = parts.join('  ·  ') || 'Ready';
                }
            });
        };

        updateRows();

        // Re-render when extension writes new data
        settings.connect('changed::cached-quota-json', () => {
            updateRows();
            refreshBtn.label = '↻  Refresh Now';
            refreshBtn.sensitive = true;
        });

        // Trigger the extension to refresh by toggling the key
        refreshBtn.connect('clicked', () => {
            refreshBtn.label = '↻  Refreshing…';
            refreshBtn.sensitive = false;

            // Also poke the panel extension (in case it's running new code)
            settings.set_boolean('request-refresh', !settings.get_boolean('request-refresh'));

            // Fetch data directly from this process so it always works,
            // even when the panel extension's JS module cache is stale.
            this._fetchAllProviders(settings).then(cache => {
                const json = JSON.stringify(cache);
                if (json.length <= 16384) settings.set_string('cached-quota-json', json);
                refreshBtn.label = '↻  Refresh Now';
                refreshBtn.sensitive = true;
            }).catch(_e => {
                refreshBtn.label = '↻  Refresh Now';
                refreshBtn.sensitive = true;
            });
        });

        return group;
    }

    // ── Providers page ─────────────────────────────────────────────────────────

    _buildProvidersPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Providers',
            icon_name: 'network-wired-symbolic',
            name: 'providers',
        });

        // ── Panel source ──────────────────────────────────────────────────────

        const panelGroup = new Adw.PreferencesGroup({
            title: 'Panel Source',
            description: 'The active provider drives the bar and icon shown in the top panel.',
        });
        page.add(panelGroup);

        const activeRow = new Adw.ComboRow({ title: 'Active provider' });
        const model = new Gtk.StringList();
        PROVIDERS.forEach(p => model.append(p.name));
        activeRow.set_model(model);
        const currentActive = settings.get_string('active-provider');
        const activeIdx = PROVIDERS.findIndex(p => p.id === currentActive);
        if (activeIdx >= 0) activeRow.set_selected(activeIdx);
        activeRow.connect('notify::selected', () => {
            const selected = activeRow.get_selected();
            if (selected < PROVIDERS.length)
                settings.set_string('active-provider', PROVIDERS[selected].id);
        });
        panelGroup.add(activeRow);

        // ── Live status ───────────────────────────────────────────────────────

        page.add(this._buildUsageGroup(settings));

        // ── Provider configuration (all providers in one group) ───────────────

        const configGroup = new Adw.PreferencesGroup({
            title: 'Provider Configuration',
            description: 'Enable providers and configure CLI paths. Disabled providers are never queried.',
        });
        page.add(configGroup);

        PROVIDERS.forEach(provConfig => {
            const cliPath = settings.get_string(provConfig.cliKey) || provConfig.cliDefault;
            const installed = cliIsInstalled(cliPath);
            const credsPath = provConfig.credsPathFn(settings);
            const authenticated = installed && fileExists(credsPath);

            const statusText = !installed ? 'Not installed'
                : !authenticated ? 'Not authenticated'
                : 'Ready';

            const expander = new Adw.ExpanderRow({
                title: provConfig.name,
                subtitle: statusText,
            });

            // Brand icon prefix
            const iconPath = `${this.path}/icons/${provConfig.id}-symbolic.svg`;
            if (GLib.file_test(iconPath, GLib.FileTest.EXISTS)) {
                const gicon = Gio.FileIcon.new(Gio.File.new_for_path(iconPath));
                const img = new Gtk.Image({ gicon, pixel_size: 24, valign: Gtk.Align.CENTER });
                expander.add_prefix(img);
            }

            // Enabled toggle
            const enabledSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
            enabledSwitch.active = settings.get_strv('enabled-providers').includes(provConfig.id);
            enabledSwitch.connect('notify::active', () => {
                const current = settings.get_strv('enabled-providers');
                const updated = enabledSwitch.active
                    ? (current.includes(provConfig.id) ? current : [...current, provConfig.id])
                    : current.filter(id => id !== provConfig.id);
                settings.set_strv('enabled-providers', updated);
            });
            expander.add_suffix(enabledSwitch);
            expander.set_enable_expansion(true);

            // Status row
            const statusRow = new Adw.ActionRow({ title: 'Status', activatable: false });
            const statusLabel = new Gtk.Label({ valign: Gtk.Align.CENTER });
            if (!installed) {
                statusLabel.label = '✗ Not installed';
                statusLabel.add_css_class('error');
            } else if (!authenticated) {
                statusLabel.label = '⚠ Not authenticated';
                statusLabel.add_css_class('warning');
            } else {
                statusLabel.label = '✓ Ready';
                statusLabel.add_css_class('success');
            }
            statusRow.add_suffix(statusLabel);
            expander.add_row(statusRow);

            // CLI path row
            expander.add_row(makeEntry(`${provConfig.name} CLI path`, settings, provConfig.cliKey));

            // Credentials path (read-only info)
            expander.add_row(new Adw.ActionRow({
                title: 'Credentials path',
                subtitle: credsPath,
                activatable: false,
            }));

            // Extra provider-specific rows (e.g. OpenCode budgets)
            if (provConfig.extraRows)
                provConfig.extraRows(expander, settings);

            configGroup.add(expander);
        });

        return page;
    }

    // ── Display page ───────────────────────────────────────────────────────────

    _buildDisplayPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Display',
            icon_name: 'preferences-desktop-display-symbolic',
            name: 'display',
        });

        // ── Panel bar ──────────────────────────────────────────────────────────

        const panelGroup = new Adw.PreferencesGroup({
            title: 'Panel Bar',
            description: 'Appearance of the usage bar in the top panel.',
        });
        page.add(panelGroup);

        panelGroup.add(makeSwitchRow(
            'Show provider icon',
            'Displays the active AI backend brand icon in the panel, coloured in its brand colour',
            settings, 'show-provider-icon'
        ));

        panelGroup.add(makeSwitchRow(
            'Show weekly bar',
            'Adds a thin stripe below the session bar showing your 7-day quota',
            settings, 'show-weekly-bar'
        ));

        const labelModeRow = new Adw.ComboRow({
            title: 'Percentage label',
            subtitle: 'Numeric quota value shown as text next to the bar',
        });
        const labelModeModel = new Gtk.StringList();
        ['Hidden', 'Session only', 'Weekly only', 'Session + Weekly'].forEach(l => labelModeModel.append(l));
        labelModeRow.set_model(labelModeModel);
        labelModeRow.set_selected(settings.get_int('panel-label-mode'));
        labelModeRow.connect('notify::selected', () => settings.set_int('panel-label-mode', labelModeRow.get_selected()));
        panelGroup.add(labelModeRow);

        panelGroup.add(makeSpinRow(
            'Bar width (px)',
            'Width of the graphical usage bar — increase if you have a wider panel',
            settings, 'meter-width', 30, 160
        ));

        // ── Color thresholds ───────────────────────────────────────────────────

        const threshGroup = new Adw.PreferencesGroup({
            title: 'Color Thresholds',
            description: 'Bar color changes as quota is consumed: green → amber → red.',
        });
        page.add(threshGroup);

        threshGroup.add(makeSpinRow(
            'Warning level (%)',
            'Bar turns amber when remaining quota falls below this percentage',
            settings, 'warning-threshold-pct', 10, 90
        ));

        threshGroup.add(makeSpinRow(
            'Critical level (%)',
            'Bar turns red when remaining quota falls below this percentage',
            settings, 'critical-threshold-pct', 5, 50
        ));

        threshGroup.add(makeSpinRow(
            'Stale data timeout (min)',
            'Bar dims when data is older than this — set higher if you refresh infrequently',
            settings, 'stale-timeout-minutes', 5, 240
        ));

        // ── Auto-refresh ───────────────────────────────────────────────────────

        const refreshGroup = new Adw.PreferencesGroup({
            title: 'Auto-Refresh',
            description: 'How and when quota data is fetched from each provider.',
        });
        page.add(refreshGroup);

        refreshGroup.add(makeSwitchRow(
            'Refresh on startup',
            'Fetch quota data automatically when you log in — disable to reduce login-time network activity',
            settings, 'startup-refresh'
        ));

        const intervalRow = new Adw.ComboRow({
            title: 'Refresh interval',
            subtitle: 'How often to poll in the background — more frequent polling uses slightly more battery',
        });
        const intervalLabels = new Gtk.StringList();
        const intervalValues = [0, 60, 120, 300, 900];
        const intervalNames  = ['Manual only', 'Every minute', 'Every 2 minutes', 'Every 5 minutes', 'Every 15 minutes'];
        intervalNames.forEach(n => intervalLabels.append(n));
        intervalRow.set_model(intervalLabels);
        const currentInterval = settings.get_int('refresh-interval-seconds');
        const intervalIdx = intervalValues.indexOf(currentInterval);
        if (intervalIdx >= 0) intervalRow.set_selected(intervalIdx);
        intervalRow.connect('notify::selected', () => {
            const sel = intervalRow.get_selected();
            if (sel < intervalValues.length) settings.set_int('refresh-interval-seconds', intervalValues[sel]);
        });
        refreshGroup.add(intervalRow);

        return page;
    }

    // ── About page ─────────────────────────────────────────────────────────────

    _buildAboutPage() {
        const page = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
            name: 'about',
        });

        // ── Header card ────────────────────────────────────────────────────────

        const headerGroup = new Adw.PreferencesGroup();
        page.add(headerGroup);

        const headerRow = new Adw.ActionRow({
            title: 'AI Usage Bar',
            subtitle: 'Glanceable AI quota meter for the GNOME top panel',
            activatable: false,
        });
        headerRow.add_prefix(new Gtk.Image({
            icon_name: 'utilities-terminal-symbolic',
            pixel_size: 56,
            valign: Gtk.Align.CENTER,
        }));
        headerGroup.add(headerRow);

        // ── Details ────────────────────────────────────────────────────────────

        const detailsGroup = new Adw.PreferencesGroup({ title: 'Details' });
        page.add(detailsGroup);

        const makeInfoRow = (title, value) => {
            const row = new Adw.ActionRow({ title, activatable: false });
            row.add_suffix(new Gtk.Label({
                label: value,
                valign: Gtk.Align.CENTER,
                css_classes: ['dim-label'],
            }));
            return row;
        };

        detailsGroup.add(makeInfoRow('Version', '1.0'));
        detailsGroup.add(makeInfoRow('Author', 'David Sokolowski'));
        detailsGroup.add(makeInfoRow('License', 'GPL v3'));

        const sourceRow = new Adw.ActionRow({
            title: 'Source code',
            subtitle: 'git.sokolowski.tech/david/ai-usage-bar',
            activatable: false,
        });
        const linkBtn = new Gtk.LinkButton({
            uri: 'https://git.sokolowski.tech/david/ai-usage-bar',
            label: 'Open',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        sourceRow.add_suffix(linkBtn);
        detailsGroup.add(sourceRow);

        // ── Quick tips ─────────────────────────────────────────────────────────

        const tipsGroup = new Adw.PreferencesGroup({
            title: 'Quick Tips',
        });
        page.add(tipsGroup);

        [
            {
                title: 'Click the panel bar',
                subtitle: 'Opens a popup with per-provider quota details and a manual refresh button',
            },
            {
                title: 'Switch active provider',
                subtitle: 'Click any provider row in the popup to make it the source for the panel bar',
            },
            {
                title: 'Multiple providers',
                subtitle: 'Enable all providers you use — each is checked independently and cached',
            },
            {
                title: 'OpenCode budgets',
                subtitle: 'Set 5h and 7d USD budgets in Provider Configuration to see a percentage bar instead of raw cost',
            },
        ].forEach(tip => {
            tipsGroup.add(new Adw.ActionRow({
                title: tip.title,
                subtitle: tip.subtitle,
                activatable: false,
            }));
        });

        // ── Credits ────────────────────────────────────────────────────────────

        const creditsGroup = new Adw.PreferencesGroup({ title: 'Credits' });
        page.add(creditsGroup);

        creditsGroup.add(new Adw.ActionRow({
            title: 'Inspired by codexbar',
            subtitle: 'steipete/codexbar — the original macOS AI menu-bar app by Peter Steinberger',
            activatable: false,
        }));

        // ── Data sources ───────────────────────────────────────────────────────

        const sourcesGroup = new Adw.PreferencesGroup({
            title: 'Data Sources',
            description: 'How each provider\'s quota is fetched. All requests use your existing CLI credentials — no separate login required.',
        });
        page.add(sourcesGroup);

        [
            {
                title: 'Claude',
                subtitle: 'GET api.anthropic.com/api/oauth/usage — returns 5-hour session and 7-day remaining percentages',
            },
            {
                title: 'Gemini',
                subtitle: 'POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota — uses the OAuth token from ~/.gemini/',
            },
            {
                title: 'Codex',
                subtitle: 'Parses PTY output from codex --status — requires the Codex CLI to be installed',
            },
            {
                title: 'Copilot',
                subtitle: 'GitHub Copilot billing API — reads the token stored by gh auth login',
            },
            {
                title: 'OpenCode',
                subtitle: 'Reads ~/.local/share/opencode/opencode.db directly — no network request, no credentials needed',
            },
        ].forEach(s => {
            sourcesGroup.add(new Adw.ActionRow({
                title: s.title,
                subtitle: s.subtitle,
                activatable: false,
            }));
        });

        return page;
    }
}
