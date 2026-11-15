import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const LAYOUTS = [['both', 'Both'], ['rectangle', 'Rectangle'], ['square', 'Square']];
const THEMES = [['light', 'Light'], ['dark', 'Dark']];
// Must match the <range max> of offset-right / offset-top in the schema.
const MAX_OFFSET = 20000;

// String keys can't be bound to a ComboRow index directly, so sync both ways by hand.
function comboRow(settings, key, title, options) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(options.map(o => o[1]))});
    const load = () => {
        const i = Math.max(0, options.findIndex(o => o[0] === settings.get_string(key)));
        if (row.selected !== i)
            row.selected = i;
    };
    load();
    row.connect('notify::selected', () => {
        const value = options[row.selected][0];
        if (settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    const id = settings.connect(`changed::${key}`, load);
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

// Bound rows follow outside changes too (e.g. dragging the widget while this window is open).
function spinRow(settings, key, title, subtitle, min, max, step) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class ScreenTimePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive for the window's lifetime
        window.set_default_size(520, 640);

        const page = new Adw.PreferencesPage({title: 'Screen Time', icon_name: 'preferences-system-time-symbolic'});
        window.add(page);

        const look = new Adw.PreferencesGroup({title: 'Widgets'});
        look.add(comboRow(settings, 'layout', 'Show', LAYOUTS));
        look.add(comboRow(settings, 'theme', 'Colors', THEMES));
        look.add(spinRow(settings, 'daily-limit-minutes', 'Daily limit', 'Minutes; shown on the square widget', 30, 1440, 15));
        page.add(look);

        const tracking = new Adw.PreferencesGroup({title: 'Tracking'});
        tracking.add(spinRow(settings, 'idle-seconds', 'Idle timeout', 'Stop counting after this many seconds without input', 30, 900, 30));
        page.add(tracking);

        const position = new Adw.PreferencesGroup({
            title: 'Position',
            description: 'Drag the widgets on the desktop, or set the offsets here.',
        });
        position.add(spinRow(settings, 'offset-right', 'Distance from right edge', 'Pixels', 0, MAX_OFFSET, 10));
        position.add(spinRow(settings, 'offset-top', 'Distance from top', 'Pixels', 0, MAX_OFFSET, 10));
        const locked = new Adw.SwitchRow({title: 'Lock position', subtitle: 'Disable dragging'});
        settings.bind('locked', locked, 'active', Gio.SettingsBindFlags.DEFAULT);
        position.add(locked);
        page.add(position);
    }
}
