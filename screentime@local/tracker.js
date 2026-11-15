// Event-driven focus tracker. Nothing polls: Mutter tells us when focus changes, the idle
// monitor tells us when input stops/resumes, and one 30 s timer persists the running span.
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TICK_SECONDS = 30;
// A span longer than this between two flushes means the machine slept; don't count it.
const MAX_SPAN_MS = TICK_SECONDS * 3 * 1000;

export class Tracker {
    constructor(store, settings, onTick) {
        this._store = store;
        this._settings = settings;
        this._onTick = onTick;
    }

    enable() {
        this._appId = null;
        this._appName = '';
        this._lastMs = Date.now();
        this._idle = false;
        this._locked = false;
        this._idleWatchId = 0;
        this._activeWatchId = 0;
        this._signals = [];

        this._windowTracker = Shell.WindowTracker.get_default();
        this._signals.push([global.display, global.display.connect('notify::focus-window', () => this._onFocus())]);

        this._monitor = global.backend.get_core_idle_monitor();
        this._addIdleWatch();
        this._signals.push([this._settings, this._settings.connect('changed::idle-seconds', () => this._addIdleWatch())]);

        const shield = Main.screenShield;
        if (shield) {
            this._signals.push([shield, shield.connect('locked-changed', () => {
                this._flushTo(Date.now());
                this._locked = !!shield.locked;
                this._lastMs = Date.now();
            })]);
        }

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            this.flush();
            this._onTick();
            return GLib.SOURCE_CONTINUE;
        });

        this._readFocus();
    }

    disable() {
        this.flush();
        this._store.save();
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        if (this._monitor) {
            if (this._idleWatchId)
                this._monitor.remove_watch(this._idleWatchId);
            if (this._activeWatchId)
                this._monitor.remove_watch(this._activeWatchId);
        }
        this._idleWatchId = this._activeWatchId = 0;
        this._monitor = null;
    }

    // Commit the span that is currently running, then keep it running.
    flush() {
        const now = Date.now();
        this._flushTo(now);
        this._lastMs = now;
        this._store.save();
    }

    get _paused() {
        return this._idle || this._locked;
    }

    _flushTo(endMs) {
        if (!this._appId || this._paused)
            return;
        const startMs = Math.max(this._lastMs, endMs - MAX_SPAN_MS);
        if (endMs > startMs)
            this._store.addSpan(startMs, endMs, this._appId, this._appName);
    }

    _readFocus() {
        const win = global.display.focus_window;
        const app = win ? this._windowTracker.get_window_app(win) : null;
        const id = app?.get_id() ?? null;
        // Windows without a .desktop file get synthetic "window:" ids; they have no name or icon worth showing.
        if (id && !id.startsWith('window:')) {
            this._appId = id;
            this._appName = app.get_name();
        } else {
            this._appId = null;
            this._appName = '';
        }
    }

    _onFocus() {
        this._flushTo(Date.now());
        this._lastMs = Date.now();
        this._readFocus();
    }

    // ---- idle handling: one persistent "went idle" watch, one one-shot "came back" watch.

    _addIdleWatch() {
        if (this._idleWatchId)
            this._monitor.remove_watch(this._idleWatchId);
        const threshold = this._settings.get_int('idle-seconds') * 1000;
        this._idleWatchId = this._monitor.add_idle_watch(threshold, () => {
            // The idle period already elapsed: only count up to where input stopped.
            this._flushTo(Date.now() - threshold);
            this._idle = true;
            this._store.save();
            this._onTick();
            this._activeWatchId = this._monitor.add_user_active_watch(() => {
                this._activeWatchId = 0;
                this._idle = false;
                this._lastMs = Date.now();
            });
        });
    }
}
