import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const LAYOUTS = [['both', 'Both'], ['rectangle', 'Rectangle'], ['square', 'Square']];
const THEMES = [['light', 'Light'], ['dark', 'Dark']];

function comboRow(settings, key, title, options) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(options.map(o => o[1]))});
    row.selected = Math.max(0, options.findIndex(o => o[0] === settings.get_string(key)));
    row.connect('notify::selected', () => settings.set_string(key, options[row.selected][0]));
    return row;
}

function spinRow(settings, key, title, subtitle, min, max, step) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, value: settings.get_int(key)}),
    });
    row.connect('notify::value', () => settings.set_int(key, row.value));
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
        position.add(spinRow(settings, 'offset-right', 'Distance from right edge', 'Pixels', 0, 4000, 10));
        position.add(spinRow(settings, 'offset-top', 'Distance from top', 'Pixels', 0, 4000, 10));
        const locked = new Adw.SwitchRow({title: 'Lock position', subtitle: 'Disable dragging', active: settings.get_boolean('locked')});
        locked.connect('notify::active', () => settings.set_boolean('locked', locked.active));
        position.add(locked);
        page.add(position);
    }
}
