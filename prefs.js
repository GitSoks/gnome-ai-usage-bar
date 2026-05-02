/**
 * AI Usage Bar — prefs.js
 * Three-page preferences: Providers, Display, About.
 */

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { ClaudeProvider } from './lib/providers/claude.js';
import { CodexProvider } from './lib/providers/codex.js';
import { CopilotProvider } from './lib/providers/copilot.js';
import { GeminiProvider } from './lib/providers/gemini.js';
import { OpenCodeProvider } from './lib/providers/opencode.js';

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
        description: 'OpenCode CLI',
        cliKey: 'opencode-cli-path',
        cliDefault: 'opencode',
        credsPathFn: () => GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'opencode', 'opencode.db']),
        extraRows: (expander, settings) => {
            // Display mode selector
            const modeRow = new Adw.ComboRow({ title: 'Display mode' });
            const modeModel = new Gtk.StringList();
            modeModel.append('Cost (USD spent)');
            modeModel.append('Go Subscription (calls used)');
            modeRow.set_model(modeModel);
            const isGo = () => settings.get_string('opencode-display-mode') === 'go-subscription';
            modeRow.set_selected(isGo() ? 1 : 0);
            modeRow.connect('notify::selected', () => {
                settings.set_string('opencode-display-mode',
                    modeRow.get_selected() === 1 ? 'go-subscription' : 'cost');
            });
            expander.add_row(modeRow);

            // Cost mode rows
            const budget5hRow = makeDoubleSpinRow(
                '5-hour budget (USD)',
                'Max spend for the 5h window — 0 shows raw cost only',
                settings, 'opencode-budget-5h', 0.0, 1000.0, 0.5
            );
            const budget7dRow = makeDoubleSpinRow(
                '7-day budget (USD)',
                'Max spend for the 7-day window — 0 shows raw cost only',
                settings, 'opencode-budget-7d', 0.0, 1000.0, 1.0
            );
            expander.add_row(budget5hRow);
            expander.add_row(budget7dRow);

            // ── Go subscription: console credentials (auto-fetch) ─────────────
            const autoFetchRow = makeSwitchRow(
                'Auto-fetch Go quotas from web',
                'Fetches real-time usage from console.opencode.ai instead of using local DB + manual quotas',
                settings, 'opencode-go-auto-fetch'
            );
            expander.add_row(autoFetchRow);

            const workspaceIdRow = makeEntry('Workspace ID (optional)', settings, 'opencode-workspace-id');
            workspaceIdRow.set_tooltip_text('Optional — found in the URL: opencode.ai/workspace/{id}/go. Only needed for scraping fallback.');
            expander.add_row(workspaceIdRow);

            const authCookieRow = makeEntry('Auth cookie', settings, 'opencode-auth-cookie');
            authCookieRow.set_tooltip_text('Copy the \'auth\' cookie value from browser DevTools → Application → Cookies → opencode.ai');
            expander.add_row(authCookieRow);

            // Go subscription mode rows (manual fallback)
            const sessionQuotaRow = makeSpinRow(
                '5h window quota (calls)',
                'Total calls per 5h session — 0 shows raw count without a bar (fallback when auto-fetch is off)',
                settings, 'opencode-go-session-quota', 0, 99999, 10
            );
            const weeklyQuotaRow = makeSpinRow(
                'Weekly quota (calls)',
                'Total calls per week — 0 shows raw count without a bar (fallback when auto-fetch is off)',
                settings, 'opencode-go-weekly-quota', 0, 99999, 50
            );
            const monthlyQuotaRow = makeSpinRow(
                'Monthly quota (calls)',
                'Total calls per month — 0 shows raw count without a bar (fallback when auto-fetch is off)',
                settings, 'opencode-go-monthly-quota', 0, 99999, 100
            );
            expander.add_row(sessionQuotaRow);
            expander.add_row(weeklyQuotaRow);
            expander.add_row(monthlyQuotaRow);

            const updateVisibility = () => {
                const go = isGo();
                const auto = settings.get_boolean('opencode-go-auto-fetch');
                budget5hRow.visible = !go;
                budget7dRow.visible = !go;
                autoFetchRow.visible = go;
                workspaceIdRow.visible = go;
                authCookieRow.visible = go;
                sessionQuotaRow.visible = go && !auto;
                weeklyQuotaRow.visible = go && !auto;
                monthlyQuotaRow.visible = go && !auto;
            };
            updateVisibility();
            settings.connect('changed::opencode-display-mode', updateVisibility);
            settings.connect('changed::opencode-go-auto-fetch', updateVisibility);
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
            new OpenCodeProvider(settings, this.path),
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

        // ── Provider configuration with live status ───────────────────────────

        const refreshBtn = new Gtk.Button({
            label: '↻  Refresh Now',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action', 'pill'],
        });

        const configGroup = new Adw.PreferencesGroup({
            title: 'Provider Configuration',
            description: 'Enable providers and configure CLI paths. Live quota shown in each row subtitle.',
            header_suffix: refreshBtn,
        });
        page.add(configGroup);

        const expanders = {};

        const updateSubtitles = () => {
            let cached = {};
            try { cached = JSON.parse(settings.get_string('cached-quota-json') || '{}'); } catch { /* ok */ }

            PROVIDERS.forEach(provConfig => {
                const expander = expanders[provConfig.id];
                if (!expander) return;
                const data = cached[provConfig.id];
                if (!data) {
                    const cliPath = settings.get_string(provConfig.cliKey) || provConfig.cliDefault;
                    const installed = cliIsInstalled(cliPath);
                    const credsPath = provConfig.credsPathFn(settings);
                    const authenticated = installed && fileExists(credsPath);
                    expander.subtitle = !installed ? 'Not installed'
                        : !authenticated ? 'Not authenticated'
                        : 'No data yet — click Refresh';
                } else if (!data.installed) {
                    expander.subtitle = 'Not installed';
                } else if (!data.authenticated) {
                    expander.subtitle = 'Not authenticated';
                } else if (data.error && !data.session && !data.weekly && !data.cost) {
                    expander.subtitle = `Error: ${data.error}`;
                } else {
                    const fmtWindow = (w) => w.remaining !== null
                        ? `${w.label.split('(')[0].trim()}: ${Math.round(w.remaining * 100)}%`
                        : w.label;
                    const parts = [];
                    if (data.session) parts.push(fmtWindow(data.session));
                    if (data.weekly)  parts.push(fmtWindow(data.weekly));
                    if (data.monthly) parts.push(fmtWindow(data.monthly));
                    if (data.cost)    parts.push(`Cost/wk: $${(data.cost.week ?? 0).toFixed(3)}`);
                    if (data._ts) {
                        const s = Math.floor((Date.now() - data._ts) / 1000);
                        const age = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
                        parts.push(age);
                    }
                    expander.subtitle = parts.join('  ·  ') || 'Ready';
                }
            });
        };

        PROVIDERS.forEach(provConfig => {
            const cliPath = settings.get_string(provConfig.cliKey) || provConfig.cliDefault;
            const installed = cliIsInstalled(cliPath);
            const credsPath = provConfig.credsPathFn(settings);
            const authenticated = installed && fileExists(credsPath);

            const expander = new Adw.ExpanderRow({
                title: provConfig.name,
                subtitle: !installed ? 'Not installed'
                    : !authenticated ? 'Not authenticated'
                    : 'No data yet — click Refresh',
            });
            expanders[provConfig.id] = expander;

            // Brand icon prefix
            const iconPath = `${this.path}/icons/${provConfig.id}-symbolic.svg`;
            if (GLib.file_test(iconPath, GLib.FileTest.EXISTS)) {
                const file = Gio.File.new_for_path(iconPath);
                const img = new Gtk.Image({ gicon: new Gio.FileIcon({ file }), pixel_size: 24, valign: Gtk.Align.CENTER });
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

        // Populate subtitles from already-cached data
        updateSubtitles();

        // Re-render subtitles whenever the extension saves new quota data
        settings.connect('changed::cached-quota-json', () => {
            updateSubtitles();
            refreshBtn.label = '↻  Refresh Now';
            refreshBtn.sensitive = true;
        });

        refreshBtn.connect('clicked', () => {
            refreshBtn.label = '↻  Refreshing…';
            refreshBtn.sensitive = false;
            settings.set_boolean('request-refresh', !settings.get_boolean('request-refresh'));
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

        const areaModeRow = new Adw.ComboRow({
            title: 'Panel area',
            subtitle: 'Which part of the top panel to show the extension in',
        });
        const areaModeModel = new Gtk.StringList();
        ['Left', 'Middle', 'Right'].forEach(l => areaModeModel.append(l));
        areaModeRow.set_model(areaModeModel);
        
        const areaMap = ['left', 'center', 'right'];
        const currentArea = settings.get_string('position-area');
        const areaIdx = areaMap.indexOf(currentArea);
        if (areaIdx >= 0) areaModeRow.set_selected(areaIdx);
        
        areaModeRow.connect('notify::selected', () => {
            const sel = areaModeRow.get_selected();
            if (sel >= 0 && sel < areaMap.length) {
                settings.set_string('position-area', areaMap[sel]);
            }
        });
        panelGroup.add(areaModeRow);

        panelGroup.add(makeSpinRow(
            'Position index',
            'Lower numbers are further left/top, higher numbers are further right/bottom',
            settings, 'position-index', 0, 100
        ));

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

        // ── Hero header ────────────────────────────────────────────────────────

        const heroGroup = new Adw.PreferencesGroup();
        page.add(heroGroup);

        const clamp = new Adw.Clamp({
            maximum_size: 600,
            margin_top: 24,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        const heroBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
        });

        const logoPath = `${this.path}/icons/logo-symbolic.svg`;
        const hasLogo = GLib.file_test(logoPath, GLib.FileTest.EXISTS);
        const logoWidget = new Gtk.Image({
            pixel_size: 72,
            halign: Gtk.Align.CENTER,
        });
        if (hasLogo) {
            const logoFile = Gio.File.new_for_path(logoPath);
            logoWidget.gicon = new Gio.FileIcon({ file: logoFile });
        } else {
            logoWidget.icon_name = 'utilities-terminal-symbolic';
        }

        const titleLabel = new Gtk.Label({
            label: 'AI Usage Bar',
            css_classes: ['title-1'],
            halign: Gtk.Align.CENTER,
        });

        const subtitleLabel = new Gtk.Label({
            label: 'Glanceable AI quota meter for the GNOME top panel',
            css_classes: ['dim-label'],
            halign: Gtk.Align.CENTER,
            wrap: true,
            justify: Gtk.Justification.CENTER,
        });

        const version = this.metadata.version ?? '1.0';
        const versionBadge = new Gtk.Label({
            label: `Version ${version}`,
            css_classes: ['caption'],
            halign: Gtk.Align.CENTER,
        });

        heroBox.append(logoWidget);
        heroBox.append(titleLabel);
        heroBox.append(subtitleLabel);
        heroBox.append(versionBadge);
        clamp.set_child(heroBox);
        heroGroup.add(clamp);

        // ── Links & Info ───────────────────────────────────────────────────────

        const infoGroup = new Adw.PreferencesGroup({
            title: 'Project',
            margin_top: 12,
        });
        page.add(infoGroup);

        const authorRow = new Adw.ActionRow({
            title: 'Author',
            subtitle: 'David Sokolowski (@GitSoks)',
            icon_name: 'user-info-symbolic',
            activatable: false,
        });
        infoGroup.add(authorRow);

        const licenseRow = new Adw.ActionRow({
            title: 'License',
            subtitle: 'GNU General Public License v3',
            icon_name: 'emblem-ok-symbolic',
            activatable: false,
        });
        infoGroup.add(licenseRow);

        const repoRow = new Adw.ActionRow({
            title: 'Source Code',
            subtitle: 'github.com/GitSoks/gnome-ai-usage-bar',
            icon_name: 'go-next-symbolic',
            activatable: true,
        });
        repoRow.connect('activated', () => {
            Gtk.show_uri(null, 'https://github.com/GitSoks/gnome-ai-usage-bar', Gdk.CURRENT_TIME);
        });
        infoGroup.add(repoRow);

        // ── How to use ─────────────────────────────────────────────────────────

        const tipsGroup = new Adw.PreferencesGroup({
            title: 'How to Use',
            description: 'A few tips to get the most out of AI Usage Bar.',
            margin_top: 12,
        });
        page.add(tipsGroup);

        [
            {
                title: 'Click the panel bar',
                subtitle: 'Open the popup to see per-provider quota details and a manual refresh button.',
                icon: 'input-mouse-symbolic',
            },
            {
                title: 'Switch active provider',
                subtitle: 'Click any provider row in the popup to make it the source for the panel bar.',
                icon: 'view-grid-symbolic',
            },
            {
                title: 'Enable multiple providers',
                subtitle: 'All enabled providers are checked independently and cached for offline viewing.',
                icon: 'network-cellular-signal-excellent-symbolic',
            },
            {
                title: 'Set OpenCode budgets',
                subtitle: 'Configure 5h and 7d USD budgets to see a percentage bar instead of raw cost.',
                icon: 'money-symbolic',
            },
            {
                title: 'Auto-fetch Go quotas',
                subtitle: 'Enter your workspace ID and auth cookie to fetch live Go subscription quotas.',
                icon: 'preferences-system-network-symbolic',
            },
        ].forEach(tip => {
            const row = new Adw.ActionRow({
                title: tip.title,
                subtitle: tip.subtitle,
                icon_name: tip.icon,
                activatable: false,
            });
            tipsGroup.add(row);
        });

        // ── Data Sources ───────────────────────────────────────────────────────

        const sourcesGroup = new Adw.PreferencesGroup({
            title: 'Data Sources',
            description: 'How each provider\'s quota is fetched. All requests use your existing CLI credentials — no separate login required.',
            margin_top: 12,
        });
        page.add(sourcesGroup);

        [
            {
                title: 'Claude',
                subtitle: 'GET api.anthropic.com — returns 5-hour session and 7-day remaining percentages.',
                icon: 'claude-symbolic',
                fallbackIcon: 'emblem-system-symbolic',
            },
            {
                title: 'Gemini',
                subtitle: 'POST cloudcode-pa.googleapis.com — uses the OAuth token from ~/.gemini/.',
                icon: 'gemini-symbolic',
                fallbackIcon: 'system-search-symbolic',
            },
            {
                title: 'Codex',
                subtitle: 'Parses PTY output from codex --status — requires the Codex CLI to be installed.',
                icon: 'codex-symbolic',
                fallbackIcon: 'utilities-terminal-symbolic',
            },
            {
                title: 'Copilot',
                subtitle: 'GitHub Copilot billing API — reads the token stored by gh auth login.',
                icon: 'copilot-symbolic',
                fallbackIcon: 'dialog-information-symbolic',
            },
            {
                title: 'OpenCode',
                subtitle: 'Reads ~/.local/share/opencode/opencode.db directly. Optionally fetches live quotas from console.opencode.ai.',
                icon: 'opencode-symbolic',
                fallbackIcon: 'preferences-system-symbolic',
            },
        ].forEach(s => {
            const row = new Adw.ActionRow({
                title: s.title,
                subtitle: s.subtitle,
                activatable: false,
            });
            const iconPath = `${this.path}/icons/${s.icon}.svg`;
            if (GLib.file_test(iconPath, GLib.FileTest.EXISTS)) {
                const file = Gio.File.new_for_path(iconPath);
                const img = new Gtk.Image({ gicon: new Gio.FileIcon({ file }), pixel_size: 16, valign: Gtk.Align.CENTER });
                row.add_prefix(img);
            } else {
                row.icon_name = s.fallbackIcon;
            }
            sourcesGroup.add(row);
        });

        // ── Credits ────────────────────────────────────────────────────────────

        const creditsGroup = new Adw.PreferencesGroup({
            title: 'Credits',
            margin_top: 12,
            margin_bottom: 24,
        });
        page.add(creditsGroup);

        const creditRow = new Adw.ActionRow({
            title: 'Inspired by codexbar',
            subtitle: 'steipete/codexbar — the original macOS AI menu-bar app by Peter Steinberger',
            icon_name: 'heart-symbolic',
            activatable: false,
        });
        creditsGroup.add(creditRow);

        return page;
    }
}
