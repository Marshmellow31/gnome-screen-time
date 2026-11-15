// Event-driven focus tracker. Nothing polls: Mutter tells us when focus changes, the idle
// monitor tells us when input stops/resumes, and one 30 s timer persists the running span.
//
// The running span is [_lastMs, now). It is only ever committed up to the *last input*, never
// past it, so time spent idle before the idle watch fires is never counted. Quiet time that is
// shorter than the idle timeout (reading, watching) is still counted: it is committed by the
// first flush after input resumes, because _lastMs stays at the last input until then.
//
// Screen lock needs no handling here: the extension has no "unlock-dialog" session mode, so
// GNOME disables it (flushing via disable()) when the screen locks.
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

const TICK_SECONDS = 30;
// The timer runs on the monotonic clock, which stops during suspend. A wall-clock gap this
// much larger than one tick means the machine slept in between.
const SLEEP_GAP_MS = TICK_SECONDS * 3 * 1000;

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
        this._lastTickMs = this._lastMs;
        this._idle = false;
        this._idleWatchId = 0;
        this._activeWatchId = 0;
        this._signals = [];

        this._windowTracker = Shell.WindowTracker.get_default();
        this._signals.push([global.display, global.display.connect('notify::focus-window', () => this._onFocus())]);

        this._monitor = global.backend.get_core_idle_monitor();
        this._addIdleWatch();
        this._signals.push([this._settings, this._settings.connect('changed::idle-seconds', () => this._addIdleWatch())]);

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            this._onTimer();
            return GLib.SOURCE_CONTINUE;
        });

        this._readFocus();
    }

    disable() {
        this.flush();
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

    // Commit the running span up to the last input, then keep it running from there.
    flush() {
        this._commitToLastInput();
        this._store.save();
    }

    _onTimer() {
        const now = Date.now();
        if (now - this._lastTickMs > SLEEP_GAP_MS) {
            // Woke from suspend: keep what ran before the last tick, drop the sleep itself.
            this._flushTo(Math.min(this._lastTickMs, this._lastInputMs()));
            this._lastMs = now;
        }
        this._lastTickMs = now;
        this.flush();
        this._onTick();
    }

    _lastInputMs() {
        return Date.now() - (this._monitor?.get_idletime() ?? 0);
    }

    _commitToLastInput() {
        const end = this._lastInputMs();
        this._flushTo(end);
        this._lastMs = Math.max(this._lastMs, end);
    }

    _flushTo(endMs) {
        if (!this._appId || this._idle)
            return;
        if (endMs > this._lastMs)
            this._store.addSpan(this._lastMs, endMs, this._appId, this._appName);
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
        // Focus usually changes because of input, so this normally commits up to "now". If an app
        // grabbed focus by itself, the quiet stretch since the last input goes to the new app once
        // the user is active again (or is dropped if they went idle).
        this._commitToLastInput();
        this._readFocus();
    }

    // ---- idle handling: one persistent "went idle" watch, one one-shot "came back" watch.

    _addIdleWatch() {
        if (this._idleWatchId)
            this._monitor.remove_watch(this._idleWatchId);
        const threshold = this._settings.get_int('idle-seconds') * 1000;
        this._idleWatchId = this._monitor.add_idle_watch(threshold, () => {
            // Everything up to the last input is committed; the idle stretch itself is not.
            this._commitToLastInput();
            this._idle = true;
            this._store.save();
            this._onTick();
            if (this._activeWatchId)
                this._monitor.remove_watch(this._activeWatchId);
            this._activeWatchId = this._monitor.add_user_active_watch(() => {
                this._activeWatchId = 0;
                this._idle = false;
                this._lastMs = Date.now();
            });
        });
    }
}
