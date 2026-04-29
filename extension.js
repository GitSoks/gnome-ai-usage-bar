/**
 * AI Usage Bar — extension.js
 * Two-bar panel meter showing session + weekly AI quota for Claude, Gemini,
 * Codex, Copilot, and OpenCode. Inspired by codexbar (macOS).
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

import { ClaudeProvider } from './lib/providers/claude.js';
import { GeminiProvider } from './lib/providers/gemini.js';
import { CodexProvider } from './lib/providers/codex.js';
import { CopilotProvider } from './lib/providers/copilot.js';
import { OpenCodeProvider } from './lib/providers/opencode.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const PROVIDER_META = {
    claude:   { icon: 'claude-symbolic',   color: '#da7756', fallbackIcon: 'emblem-system-symbolic' },
    gemini:   { icon: 'gemini-symbolic',   color: '#1a73e8', fallbackIcon: 'system-search-symbolic' },
    codex:    { icon: 'codex-symbolic',    color: '#10a37f', fallbackIcon: 'utilities-terminal-symbolic' },
    copilot:  { icon: 'copilot-symbolic',  color: '#8957e5', fallbackIcon: 'dialog-information-symbolic' },
    opencode: { icon: 'opencode-symbolic', color: '#f97316', fallbackIcon: 'preferences-system-symbolic' },
};

const REFRESH_PRESETS = [
    { label: 'Manual only', value: 0 },
    { label: 'Every minute', value: 60 },
    { label: 'Every 2 min', value: 120 },
    { label: 'Every 5 min', value: 300 },
    { label: 'Every 15 min', value: 900 },
];

// ── Drawing helpers (Cairo) ───────────────────────────────────────────────────

function rrect(cr, x, y, w, h, r) {
    if (w <= 0 || h <= 0) return;
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r,     r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0,            Math.PI / 2);
    cr.arc(x + r,     y + h - r, r, Math.PI / 2,  Math.PI);
    cr.arc(x + r,     y + r,     r, Math.PI,       3 * Math.PI / 2);
    cr.closePath();
}

function colorForPct(pct, warnThr, critThr) {
    if (pct === null || pct === undefined) return [0.55, 0.55, 0.55]; // grey
    if (pct <= critThr / 100)  return [0.875, 0.106, 0.141]; // red   #e01b24
    if (pct <= warnThr / 100)  return [0.898, 0.647, 0.039]; // amber #e5a50a
    return [0.341, 0.890, 0.537];                             // green #57e389
}

// ── Panel meter widget ─────────────────────────────────────────────────────────

const MeterWidget = GObject.registerClass(
class MeterWidget extends St.DrawingArea {
    _init() {
        super._init({
            width: 56,
            height: 20,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'aib-meter',
        });
        this._sessionPct = null;  // null = unknown
        this._weeklyPct  = null;
        this._warnThr = 50;
        this._critThr = 20;
        this._stale = false;
        this.connect('repaint', this._draw.bind(this));
    }

    setData(sessionPct, weeklyPct, { warnThr = 50, critThr = 20, stale = false, showWeekly = true } = {}) {
        this._sessionPct = sessionPct;
        this._weeklyPct  = showWeekly ? weeklyPct : null;
        this._warnThr    = warnThr;
        this._critThr    = critThr;
        this._stale      = stale;
        this.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();

        const sessionH = this._weeklyPct !== null ? 13 : h;
        const weeklyH  = 5;
        const gap      = 2;

        const alpha = this._stale ? 0.35 : 1.0;

        // Session bar background
        cr.setSourceRGBA(1, 1, 1, 0.10 * (this._stale ? 0.5 : 1));
        rrect(cr, 0, 0, w, sessionH, 2.5);
        cr.fill();

        // Session fill
        const sPct = this._sessionPct ?? 0;
        if (sPct > 0.005) {
            const [r, g, b] = colorForPct(this._sessionPct, this._warnThr, this._critThr);
            cr.setSourceRGBA(r, g, b, alpha);
            rrect(cr, 0, 0, w * sPct, sessionH, 2.5);
            cr.fill();
        }

        // Unknown state indicator (hatching for null)
        if (this._sessionPct === null) {
            cr.setSourceRGBA(0.6, 0.6, 0.6, 0.4);
            rrect(cr, 0, 0, w * 0.35, sessionH, 2.5);
            cr.fill();
            cr.setSourceRGBA(0.6, 0.6, 0.6, 0.25);
            rrect(cr, w * 0.45, 0, w * 0.2, sessionH, 2.5);
            cr.fill();
        }

        // Weekly bar
        if (this._weeklyPct !== null) {
            const wY = sessionH + gap;

            cr.setSourceRGBA(1, 1, 1, 0.08 * (this._stale ? 0.5 : 1));
            rrect(cr, 0, wY, w, weeklyH, 2);
            cr.fill();

            const wPct = this._weeklyPct ?? 0;
            if (wPct > 0.005) {
                const [r, g, b] = colorForPct(this._weeklyPct, this._warnThr, this._critThr);
                cr.setSourceRGBA(r, g, b, alpha * 0.85);
                rrect(cr, 0, wY, w * wPct, weeklyH, 2);
                cr.fill();
            }
        }

        cr.$dispose();
    }
});

// ── Popup progress bar widget ─────────────────────────────────────────────────

const QuotaBar = GObject.registerClass(
class QuotaBar extends St.DrawingArea {
    _init(width = 140) {
        super._init({
            width,
            height: 6,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'aib-quota-bar',
        });
        this._pct   = null;
        this._color = [0.341, 0.890, 0.537];
        this.connect('repaint', this._draw.bind(this));
    }

    setData(pct, color) {
        this._pct   = pct;
        this._color = color;
        this.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const r = h / 2;

        cr.setSourceRGBA(1, 1, 1, 0.08);
        rrect(cr, 0, 0, w, h, r);
        cr.fill();

        const pct = this._pct ?? 0;
        if (pct > 0.005) {
            const [ri, gi, bi] = this._color;
            cr.setSourceRGBA(ri, gi, bi, this._pct === null ? 0.3 : 1.0);
            rrect(cr, 0, 0, w * pct, h, r);
            cr.fill();
        }

        cr.$dispose();
    }
});

// ── Format helpers ─────────────────────────────────────────────────────────────

function formatCountdown(date) {
    if (!date || !(date instanceof Date) || isNaN(date)) return '';
    const diffMs = date - Date.now();
    if (diffMs <= 0) return 'now';
    const totalSec = Math.floor(diffMs / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins  = Math.floor((totalSec % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

function formatResetLabel(date) {
    if (!date || isNaN(date)) return '';
    return `resets in ${formatCountdown(date)}`;
}

function formatCost(usd) {
    if (usd === 0) return '$0.00';
    if (usd < 0.001) return '<$0.001';
    return `$${usd.toFixed(3)}`;
}

function timeAgo(ms) {
    if (!ms) return 'never';
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 5)   return 'just now';
    if (s < 60)  return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
}

// ── Main indicator ─────────────────────────────────────────────────────────────

const AIUsageIndicator = GObject.registerClass(
class AIUsageIndicator extends PanelMenu.Button {

    _init(extension) {
        super._init(0.0, 'AI Usage Bar');
        this._ext = extension;

        // Panel box: meter + optional provider label
        const panelBox = new St.BoxLayout({
            vertical: false,
            style_class: 'panel-status-indicators-box',
        });

        // Active provider brand icon — shown before the usage bar
        this._providerIcon = new St.Icon({
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'aib-panel-icon',
        });
        panelBox.add_child(this._providerIcon);

        this._meter = new MeterWidget();
        panelBox.add_child(this._meter);

        // Percentage label(s) — content driven by panel-label-mode setting
        this._panelPctLabel = new St.Label({
            text: '',
            style_class: 'aib-panel-pct',
            y_align: Clutter.ActorAlign.CENTER,
        });
        panelBox.add_child(this._panelPctLabel);

        this.add_child(panelBox);

        // Wider menu
        this.menu.box.style = 'min-width: 380px;';

        this._timerId    = null;
        this._sleepId    = null;
        this._lastRefresh = null;
        this._refreshTs  = null;
        this._cache      = {};         // id → result
        this._countdownTimer = null;
        this._initialLoad = true;

        this._buildMenu();
        this._startSleepMonitor();

        // Apply meter width from settings before first paint
        this._meter.set_width(this._ext.settings.get_int('meter-width'));

        this._applySettings();

        // Connect to settings changes
        this._settingsSignals = [
            this._ext.settings.connect('changed::active-provider', () => this._onActiveProviderChanged()),
            this._ext.settings.connect('changed::refresh-interval-seconds', () => this._applySettings()),
            this._ext.settings.connect('changed::show-weekly-bar', () => this._updatePanelMeter()),
            this._ext.settings.connect('changed::warning-threshold-pct', () => this._updatePanelMeter()),
            this._ext.settings.connect('changed::critical-threshold-pct', () => this._updatePanelMeter()),
            this._ext.settings.connect('changed::panel-label-mode', () => this._updatePanelMeter()),
            this._ext.settings.connect('changed::show-provider-icon', () => this._updatePanelMeter()),
            this._ext.settings.connect('changed::stale-timeout-minutes', () => this._updatePanelMeter()),
            this._ext.settings.connect('changed::meter-width', () => {
                this._meter.set_width(this._ext.settings.get_int('meter-width'));
                this._meter.queue_repaint();
            }),
            this._ext.settings.connect('changed::opencode-budget-5h', () => { this._updatePanelMeter(); if (this.menu.isOpen) this._rebuildProviderRows(); }),
            this._ext.settings.connect('changed::opencode-budget-7d', () => { this._updatePanelMeter(); if (this.menu.isOpen) this._rebuildProviderRows(); }),
            this._ext.settings.connect('changed::request-refresh', () => this.refresh().catch(e => logError(e, 'AIUsageBar'))),
            // Pick up data written by the prefs window's own fetching
            this._ext.settings.connect('changed::cached-quota-json', () => {
                this._loadCache();
                this._updatePanelMeter();
                if (this.menu.isOpen) this._rebuildProviderRows();
            }),
        ];

        // Rebuild provider rows when menu opens
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._rebuildProviderRows();
                this._startCountdownTimer();
            } else {
                this._stopCountdownTimer();
            }
        });

        // Load cached data
        this._loadCache();
        this._updatePanelMeter();
    }

    // ── Menu construction ──────────────────────────────────────────────────────

    _buildMenu() {
        // Header
        this._headerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: 'aib-header-item' });
        const hBox = new St.BoxLayout({ x_expand: true, vertical: false });

        const titleBox = new St.BoxLayout({ vertical: true, x_expand: true });
        this._titleLabel = new St.Label({ text: 'AI Usage Bar', style_class: 'aib-title' });
        this._refreshedLabel = new St.Label({ text: 'Last refreshed: never', style_class: 'aib-subtitle' });
        titleBox.add_child(this._titleLabel);
        titleBox.add_child(this._refreshedLabel);
        hBox.add_child(titleBox);

        this._refreshBtn = new St.Button({
            label: '↻',
            style_class: 'aib-refresh-btn',
            can_focus: true,
            reactive: true,
        });
        this._refreshBtn.connect('clicked', () => {
            this._refreshBtn.label = '↻';
            this._refreshBtn.remove_style_class_name('aib-refresh-btn-spinning');
            this.refresh().catch(e => logError(e, 'AIUsageBar'));
        });
        hBox.add_child(this._refreshBtn);
        this._headerItem.add_child(hBox);
        this.menu.addMenuItem(this._headerItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Provider rows section (rebuilt dynamically)
        this._providerSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._providerSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Refresh interval submenu
        this._intervalMenu = new PopupMenu.PopupSubMenuMenuItem('Auto-refresh: Every 5 min');
        if (this._intervalMenu.icon) this._intervalMenu.icon.icon_name = 'alarm-symbolic';
        this._rebuildIntervalMenu();
        this.menu.addMenuItem(this._intervalMenu);

        // Settings
        const settingsItem = new PopupMenu.PopupImageMenuItem('Extension Preferences', 'preferences-system-symbolic');
        settingsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    _rebuildIntervalMenu() {
        this._intervalMenu.menu.removeAll();
        const current = this._ext.settings.get_int('refresh-interval-seconds');

        REFRESH_PRESETS.forEach(preset => {
            const item = new PopupMenu.PopupMenuItem(preset.label);
            if (preset.value === current) {
                item.setOrnament(PopupMenu.Ornament.DOT);
                this._intervalMenu.label.text = `Auto-refresh: ${preset.label}`;
            } else {
                item.setOrnament(PopupMenu.Ornament.NONE);
            }
            item.connect('activate', () => {
                this._ext.settings.set_int('refresh-interval-seconds', preset.value);
                this._applySettings();
                this._rebuildIntervalMenu();
            });
            this._intervalMenu.menu.addMenuItem(item);
        });
    }

    // ── Provider rows ──────────────────────────────────────────────────────────

    _rebuildProviderRows() {
        this._providerSection.removeAll();
        const activeId = this._ext.settings.get_string('active-provider');
        const enabled  = this._ext.settings.get_strv('enabled-providers');
        const warnThr  = this._ext.settings.get_int('warning-threshold-pct');
        const critThr  = this._ext.settings.get_int('critical-threshold-pct');

        const providers = this._ext.providers.filter(p => enabled.includes(p.id));

        if (providers.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No providers enabled — open Preferences', { reactive: false });
            empty.label.style_class = 'aib-empty-label';
            this._providerSection.addMenuItem(empty);
            return;
        }

        providers.forEach(provider => {
            const data  = this._cache[provider.id];
            const isActive = provider.id === activeId;
            const item = this._makeProviderRow(provider, data, isActive, warnThr, critThr);
            item.connect('activate', () => {
                this._ext.settings.set_string('active-provider', provider.id);
                this._rebuildProviderRows();
                this._updatePanelMeter();
            });
            this._providerSection.addMenuItem(item);
        });

        this._updateRefreshedLabel();
    }

    _makeProviderRow(provider, data, isActive, warnThr, critThr) {
        const item = new PopupMenu.PopupBaseMenuItem({ style_class: 'aib-provider-item' });
        const outer = new St.BoxLayout({ vertical: true, x_expand: true });

        // ── Top row: icon + name + badges ──
        const topRow = new St.BoxLayout({ vertical: false, x_expand: true });

        // Provider icon (with active indicator via opacity/color)
        const meta = PROVIDER_META[provider.id];
        const gicon = this._ext.providerGicons?.[provider.id];
        const provIcon = new St.Icon({
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'aib-provider-icon',
            style: isActive
                ? `color: ${meta.color};`
                : `color: ${meta.color}; opacity: 0.45;`,
        });
        if (gicon) {
            provIcon.gicon = gicon;
        } else {
            provIcon.icon_name = meta.fallbackIcon;
        }
        topRow.add_child(provIcon);

        // Provider name
        const nameLabel = new St.Label({
            text: provider.displayName,
            style_class: isActive ? 'aib-provider-name-active' : 'aib-provider-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        topRow.add_child(nameLabel);

        // Status badge
        const badge = this._makeBadge(data, isActive);
        topRow.add_child(badge);

        outer.add_child(topRow);

        // ── Quota bars (if data available) ──
        if (data?.installed && data?.authenticated && !data?.error) {
            if (data.session) {
                const sessionRow = this._makeBarRow(data.session, warnThr, critThr);
                outer.add_child(sessionRow);
            }
            if (data.weekly) {
                const weeklyRow = this._makeBarRow(data.weekly, warnThr, critThr);
                outer.add_child(weeklyRow);
            }
            if (data.cost && !data.session && !data.weekly) {
                const b5h = this._ext.settings.get_double('opencode-budget-5h');
                const b7d = this._ext.settings.get_double('opencode-budget-7d');
                if (b5h > 0) {
                    const pct = Math.max(0, (b5h - (data.cost.today ?? 0)) / b5h);
                    outer.add_child(this._makeBarRow({ label: '5h budget', remaining: pct }, warnThr, critThr));
                }
                if (b7d > 0) {
                    const pct = Math.max(0, (b7d - (data.cost.week ?? 0)) / b7d);
                    outer.add_child(this._makeBarRow({ label: '7d budget', remaining: pct }, warnThr, critThr));
                }
                const costRow = this._makeCostRow(data.cost, data.tokens, data.calls7d);
                outer.add_child(costRow);
            }
        } else if (data?.cost && data?.installed) {
            // Partial data: has cost info even if auth error
            const costRow = this._makeCostRow(data.cost, data.tokens, data.calls7d);
            outer.add_child(costRow);
        }

        item.add_child(outer);
        return item;
    }

    _makeBadge(data, isActive) {
        let text, styleClass;

        if (!data) {
            text = 'Not checked';
            styleClass = 'aib-badge-unknown';
        } else if (!data.installed) {
            text = 'Not installed';
            styleClass = 'aib-badge-off';
        } else if (!data.authenticated) {
            text = 'Not authenticated';
            styleClass = 'aib-badge-warn';
        } else if (data.error && !data.session && !data.weekly && !data.cost) {
            text = 'Error';
            styleClass = 'aib-badge-error';
        } else if (isActive) {
            text = 'Active';
            styleClass = 'aib-badge-active';
        } else {
            text = '';
            styleClass = '';
        }

        return new St.Label({ text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER });
    }

    _makeBarRow(windowData, warnThr, critThr) {
        const row = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'aib-bar-row',
        });

        const labelBox = new St.BoxLayout({ vertical: false });
        const label = new St.Label({
            text: windowData.label ?? 'Session',
            style_class: 'aib-bar-label',
            width: 90,
            y_align: Clutter.ActorAlign.CENTER,
        });
        labelBox.add_child(label);
        row.add_child(labelBox);

        const pct = windowData.remaining;
        const color = colorForPct(pct, warnThr, critThr);
        const bar = new QuotaBar(130);
        bar.setData(pct, color);
        row.add_child(bar);

        const pctLabel = new St.Label({
            text: pct !== null ? `${Math.round(pct * 100)}%` : '—',
            style_class: 'aib-bar-pct',
            width: 36,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(pctLabel);

        if (windowData.resetAt) {
            const resetLabel = new St.Label({
                text: formatResetLabel(windowData.resetAt),
                style_class: 'aib-bar-reset',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(resetLabel);
        }

        return row;
    }

    _makeCostRow(cost, tokens, calls) {
        const row = new St.BoxLayout({ vertical: false, x_expand: true, style_class: 'aib-cost-row' });

        const fiveHText = `5h: ${formatCost(cost.today ?? 0)}`;
        const weekText  = `week: ${formatCost(cost.week ?? 0)}`;
        const label = new St.Label({
            text: `${fiveHText}  ·  ${weekText}`,
            style_class: 'aib-cost-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(label);

        if (calls) {
            const callsLabel = new St.Label({
                text: `${calls} req`,
                style_class: 'aib-cost-calls',
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(callsLabel);
        }

        return row;
    }

    _updateRefreshedLabel() {
        this._refreshedLabel.text = `Last refreshed: ${timeAgo(this._refreshTs)}`;
    }

    _startCountdownTimer() {
        this._stopCountdownTimer();
        this._countdownTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 5, () => {
            this._updateRefreshedLabel();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopCountdownTimer() {
        if (this._countdownTimer !== null) {
            GLib.source_remove(this._countdownTimer);
            this._countdownTimer = null;
        }
    }

    // ── Panel meter ────────────────────────────────────────────────────────────

    _updatePanelMeter() {
        const activeId = this._ext.settings.get_string('active-provider');
        const data = this._cache[activeId];
        const showWeekly = this._ext.settings.get_boolean('show-weekly-bar');
        const warnThr = this._ext.settings.get_int('warning-threshold-pct');
        const critThr = this._ext.settings.get_int('critical-threshold-pct');

        const staleMs = this._ext.settings.get_int('stale-timeout-minutes') * 60 * 1000;
        const isStale = this._refreshTs
            ? (Date.now() - this._refreshTs) > staleMs
            : true;

        let sessionPct = null, weeklyPct = null;
        if (data?.session?.remaining !== undefined) sessionPct = data.session.remaining;
        if (data?.weekly?.remaining !== undefined)  weeklyPct  = data.weekly.remaining;
        if (data?.cost && !data?.session) {
            // Cost-based provider (OpenCode): convert to remaining-budget % if budgets are set
            const b5h = this._ext.settings.get_double('opencode-budget-5h');
            const b7d = this._ext.settings.get_double('opencode-budget-7d');
            if (b5h > 0)
                sessionPct = Math.max(0, (b5h - (data.cost.today ?? 0)) / b5h);
            if (b7d > 0)
                weeklyPct  = Math.max(0, (b7d  - (data.cost.week  ?? 0)) / b7d);
        }

        this._meter.setData(sessionPct, weeklyPct, { warnThr, critThr, stale: isStale && !data, showWeekly });

        // Update provider icon in panel
        const showIcon = this._ext.settings.get_boolean('show-provider-icon');
        this._providerIcon.visible = showIcon;
        if (showIcon && activeId && PROVIDER_META[activeId]) {
            const meta = PROVIDER_META[activeId];
            const gicon = this._ext.providerGicons?.[activeId];
            if (gicon) {
                this._providerIcon.gicon = gicon;
            } else {
                this._providerIcon.gicon = null;
                this._providerIcon.icon_name = meta.fallbackIcon;
            }
            this._providerIcon.style = `color: ${meta.color};`;
        }

        // Update percentage label
        const labelMode = this._ext.settings.get_int('panel-label-mode');
        const sPctStr = sessionPct !== null ? `${Math.round(sessionPct * 100)}%` : '—';
        const wPctStr = weeklyPct  !== null ? `${Math.round(weeklyPct  * 100)}%` : '—';
        let labelText = '';
        if (labelMode === 1) labelText = sPctStr;
        else if (labelMode === 2) labelText = wPctStr;
        else if (labelMode === 3) labelText = sessionPct !== null || weeklyPct !== null
            ? (showWeekly && weeklyPct !== null ? `${sPctStr} · ${wPctStr}` : sPctStr)
            : '';
        this._panelPctLabel.text = labelText;
        this._panelPctLabel.style = '';

        // Tooltip
        let tooltip = `AI Usage Bar — ${activeId ?? 'none'}`;
        if (data?.session) {
            tooltip += `\nSession: ${Math.round(data.session.remaining * 100)}%`;
            if (data.session.resetAt) tooltip += ` · ${formatResetLabel(data.session.resetAt)}`;
        }
        if (data?.weekly) {
            tooltip += `\nWeekly: ${Math.round(data.weekly.remaining * 100)}%`;
            if (data.weekly.resetAt) tooltip += ` · ${formatResetLabel(data.weekly.resetAt)}`;
        }
        if (data?.cost) tooltip += `\n5h cost: ${formatCost(data.cost.today ?? 0)}`;
        if (data?.error) tooltip += `\n⚠ ${data.error}`;
        this.set_name(tooltip);
    }

    _onActiveProviderChanged() {
        this._updatePanelMeter();
        if (this.menu.isOpen) this._rebuildProviderRows();
    }

    // ── Refresh orchestration ──────────────────────────────────────────────────

    async refresh() {
        this._refreshBtn?.add_style_class_name('aib-refresh-btn-spinning');
        try {
            const enabled = this._ext.settings.get_strv('enabled-providers');
            const providers = this._ext.providers.filter(p => enabled.includes(p.id));

            await Promise.all(providers.map(p => this._refreshOne(p)));

            this._refreshTs = Date.now();
            this._saveCache();
            this._updatePanelMeter();
            if (this.menu.isOpen) {
                this._rebuildProviderRows();
            }
        } finally {
            this._refreshBtn?.remove_style_class_name('aib-refresh-btn-spinning');
        }
    }

    async _refreshOne(provider) {
        if (provider.inFlight) return;
        try {
            const result = await provider.fetchQuota();
            this._cache[provider.id] = { ...result, _ts: Date.now() };
        } catch (e) {
            this._cache[provider.id] = {
                installed: true, authenticated: false, error: e.message, _ts: Date.now(),
            };
        }
    }

    // ── Timer & sleep monitor ─────────────────────────────────────────────────

    _applySettings() {
        this._stopTimer();
        const interval = this._ext.settings.get_int('refresh-interval-seconds');
        if (interval > 0) {
            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
                this.refresh().catch(e => logError(e, 'AIUsageBar'));
                return GLib.SOURCE_CONTINUE;
            });
        }
        if (this._initialLoad) {
            this._initialLoad = false;
            if (this._ext.settings.get_boolean('startup-refresh'))
                this.refresh().catch(e => logError(e, 'AIUsageBar'));
        } else if (interval > 0) {
            // Refresh immediately when interval is changed to a non-zero value
            this.refresh().catch(e => logError(e, 'AIUsageBar'));
        }
    }

    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _startSleepMonitor() {
        try {
            this._sleepId = Gio.DBus.system.signal_subscribe(
                null,
                'org.freedesktop.login1.Manager',
                'PrepareForSleep',
                '/org/freedesktop/login1',
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    const [sleeping] = params.deep_unpack();
                    if (!sleeping) {
                        // Resume from suspend — refresh after a short delay
                        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                            this.refresh().catch(e => logError(e, 'AIUsageBar'));
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                }
            );
        } catch (e) {
            logError(e, 'AIUsageBar: could not subscribe to PrepareForSleep');
        }
    }

    _stopSleepMonitor() {
        if (this._sleepId !== null) {
            try { Gio.DBus.system.signal_unsubscribe(this._sleepId); } catch { /* ok */ }
            this._sleepId = null;
        }
    }

    // ── Cache persistence ──────────────────────────────────────────────────────

    _saveCache() {
        try {
            const json = JSON.stringify(this._cache);
            if (json.length <= 8192) {
                this._ext.settings.set_string('cached-quota-json', json);
            }
        } catch { /* non-fatal */ }
    }

    _loadCache() {
        try {
            const raw = this._ext.settings.get_string('cached-quota-json');
            if (raw && raw !== '{}') {
                this._cache = JSON.parse(raw);
                // Restore Date objects in resetAt fields
                for (const id of Object.keys(this._cache)) {
                    const d = this._cache[id];
                    if (d?.session?.resetAt) d.session.resetAt = new Date(d.session.resetAt);
                    if (d?.weekly?.resetAt)  d.weekly.resetAt  = new Date(d.weekly.resetAt);
                }
                // Stale if > 30min
                this._refreshTs = Object.values(this._cache).reduce((max, v) =>
                    Math.max(max, v?._ts ?? 0), 0) || null;
            }
        } catch { /* non-fatal */ }
    }

    // ── Cleanup ────────────────────────────────────────────────────────────────

    destroy() {
        this._stopTimer();
        this._stopSleepMonitor();
        this._stopCountdownTimer();
        if (this._settingsSignals) {
            this._settingsSignals.forEach(id => this._ext.settings.disconnect(id));
            this._settingsSignals = [];
        }
        super.destroy();
    }
});

// ── Extension ─────────────────────────────────────────────────────────────────

export default class AIUsageBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // Build per-provider Gio.FileIcon for the bundled SVGs
        const iconsDir = this.path + '/icons';
        this.providerGicons = {};
        for (const id of Object.keys(PROVIDER_META)) {
            const svgPath = `${iconsDir}/${id}-symbolic.svg`;
            try {
                const file = Gio.File.new_for_path(svgPath);
                if (file.query_exists(null))
                    this.providerGicons[id] = new Gio.FileIcon({ file });
            } catch { /* icon not found, fall back to icon_name */ }
        }

        this.providers = [
            new ClaudeProvider(this._settings),
            new GeminiProvider(this._settings),
            new CodexProvider(this._settings),
            new CopilotProvider(this._settings),
            new OpenCodeProvider(this._settings),
        ];

        this._indicator = new AIUsageIndicator(this);
        Main.panel.addToStatusArea('ai-usage-bar', this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this.providers = null;
        this.providerGicons = null;
        this._settings = null;
    }

    get settings() {
        return this._settings;
    }
}
