import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Store, dateKey} from './store.js';
import {Tracker} from './tracker.js';
import {RectCard, SquareCard, GAP} from './widgets.js';

// Must match the <range max> of offset-right / offset-top in the schema.
const MAX_OFFSET = 20000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export default class ScreenTimeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._signals = [];

        this._store = new Store();
        this._tracker = new Tracker(this._store, this._settings, () => this._render());
        this._rect = new RectCard();
        this._square = new SquareCard();

        this._root = new St.BoxLayout({reactive: true, style: `spacing: ${GAP}px;`});
        this._root.add_child(this._rect.actor);
        this._root.add_child(this._square.actor);

        // Drag to reposition; offsets stay editable in settings if DragAction ever goes away.
        this._drag = null;
        if (Clutter.DragAction) {
            this._drag = new Clutter.DragAction();
            this._root.add_action(this._drag);
            this._drag.connect('drag-end', () => this._saveDraggedPosition());
        }

        // Draw on the desktop layer: above the wallpaper, below windows.
        Main.layoutManager._backgroundGroup.add_child(this._root);
        this._signals.push([Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._place())]);

        const on = (key, fn) => this._signals.push([this._settings, this._settings.connect(`changed::${key}`, fn)]);
        for (const key of ['layout', 'theme', 'daily-limit-minutes'])
            on(key, () => this._render());
        on('locked', () => this._applyLocked());
        for (const key of ['offset-right', 'offset-top'])
            on(key, () => this._place());

        this._tracker.enable();
        this._applyLocked();
        this._render();
    }

    disable() {
        this._tracker?.disable();
        this._tracker = null;
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this._rect?.destroy();
        this._root?.destroy();
        this._root = null;
        this._rect = null;
        this._square = null;
        this._drag = null;
        this._store = null;
        this._settings = null;
    }

    _render() {
        if (!this._root)
            return;
        const layout = this._settings.get_string('layout');
        this._rect.actor.visible = layout !== 'square';
        this._square.actor.visible = layout !== 'rectangle';

        if (this._settings.get_string('theme') === 'dark')
            this._root.add_style_class_name('sct-dark');
        else
            this._root.remove_style_class_name('sct-dark');

        const summary = this._store.summary(dateKey(Date.now()));
        const opts = {
            dark: this._settings.get_string('theme') === 'dark',
            limitMinutes: this._settings.get_int('daily-limit-minutes'),
        };
        this._rect.update(summary, opts);
        this._square.update(summary, opts);
        this._place();
    }

    _applyLocked() {
        if (this._drag)
            this._drag.enabled = !this._settings.get_boolean('locked');
    }

    _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    _place() {
        if (!this._root)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const scale = this._scale();
        const [, width] = this._root.get_preferred_width(-1);
        const x = monitor.x + monitor.width - width - this._settings.get_int('offset-right') * scale;
        const y = monitor.y + this._settings.get_int('offset-top') * scale;
        this._root.set_position(Math.round(x), Math.round(y));
    }

    _saveDraggedPosition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const scale = this._scale();
        const [width, height] = this._root.get_size();
        let [x, y] = this._root.get_position();
        // Offsets are relative to the primary monitor: keep a drop that strays off it (onto
        // another monitor, or past an edge) on the primary instead of snapping back.
        x = clamp(x, monitor.x, monitor.x + monitor.width - width);
        y = clamp(y, monitor.y, monitor.y + monitor.height - height);
        this._settings.set_int('offset-right', clamp(Math.round((monitor.x + monitor.width - width - x) / scale), 0, MAX_OFFSET));
        this._settings.set_int('offset-top', clamp(Math.round((y - monitor.y) / scale), 0, MAX_OFFSET));
        this._place();
    }
}
