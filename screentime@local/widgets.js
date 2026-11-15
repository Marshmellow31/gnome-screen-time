// Two cards, each exposing `actor` and `update(summary, opts)`:
//   RectCard   (2 x 1): total, hourly stacked chart, top 4 apps   -- mockup "Rectangle A"
//   SquareCard (1 x 1): total, daily-limit bar, top app           -- mockup "Square C"
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import AccountsService from 'gi://AccountsService';

export const CELL = 170;
export const GAP = 14;

// ---------------------------------------------------------------- helpers

export function formatDuration(seconds) {
    const total = Math.floor(seconds / 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Chart segments, bottom to top.
const CATEGORY_COLORS = [
    [0.184, 0.420, 1.000], // develop  #2F6BFF
    [0.184, 0.655, 0.722], // browse   #2FA7B8
    [0.961, 0.620, 0.043], // social   #F59E0B
    [0.769, 0.780, 0.808], // other    #C4C7CE
];

const DEVELOP = ['Development', 'IDE', 'TerminalEmulator', 'TextEditor'];
const BROWSE = ['WebBrowser'];
const SOCIAL = ['InstantMessaging', 'Chat', 'Email', 'Network', 'VideoConference', 'Telephony'];
const categoryCache = new Map();

function categoryOf(appId) {
    if (categoryCache.has(appId))
        return categoryCache.get(appId);
    const info = Shell.AppSystem.get_default().lookup_app(appId)?.get_app_info();
    const cats = (info?.get_categories?.() ?? '').split(';');
    let cat = 3;
    if (cats.some(c => DEVELOP.includes(c)))
        cat = 0;
    else if (cats.some(c => BROWSE.includes(c)))
        cat = 1;
    else if (cats.some(c => SOCIAL.includes(c)))
        cat = 2;
    categoryCache.set(appId, cat);
    return cat;
}

function label(styleClass, text = '') {
    return new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
}

function appIcon(size) {
    return new St.Icon({icon_size: size, icon_name: 'application-x-executable-symbolic', style_class: 'sct-app-icon'});
}

function setAppIcon(icon, appId) {
    const app = Shell.AppSystem.get_default().lookup_app(appId);
    if (app?.get_icon())
        icon.gicon = app.get_icon();
    else
        icon.icon_name = 'application-x-executable-symbolic';
}

// ---------------------------------------------------------------- hourly chart

class HourChart {
    constructor() {
        this.actor = new St.DrawingArea({x_expand: true, y_expand: true});
        this._hours = null;
        this._dark = false;
        this.actor.connect('repaint', area => this._paint(area));
    }

    update(hours, dark) {
        this._hours = hours;
        this._dark = dark;
        this.actor.queue_repaint();
    }

    _paint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const grid = this._dark ? [1, 1, 1, 0.14] : [0, 0, 0, 0.10];
        const base = this._dark ? [1, 1, 1, 0.30] : [0, 0, 0, 0.22];

        // Horizontal guides at 60m, 30m and 0m.
        cr.setLineWidth(1);
        cr.setSourceRGBA(...grid);
        for (const y of [0.5, h / 2, h - 0.5]) {
            if (y === h - 0.5)
                cr.setSourceRGBA(...base);
            cr.moveTo(0, y);
            cr.lineTo(w, y);
            cr.stroke();
        }

        // Dashed guides at 12 AM, 6 AM, 12 PM, 6 PM.
        cr.setSourceRGBA(...grid);
        cr.setDash([3, 3], 0);
        for (const f of [0, 0.25, 0.5, 0.75]) {
            cr.moveTo(Math.round(w * f) + 0.5, 0);
            cr.lineTo(Math.round(w * f) + 0.5, h);
            cr.stroke();
        }
        cr.setDash([], 0);

        // One stacked bar per hour; a full bar is 60 minutes.
        if (this._hours) {
            const slot = w / 24;
            const gap = Math.max(1, slot * 0.2);
            for (let hour = 0; hour < 24; hour++) {
                const perCat = [0, 0, 0, 0];
                for (const [id, secs] of Object.entries(this._hours[hour]))
                    perCat[categoryOf(id)] += secs;
                let y = h - 1;
                for (let c = 0; c < 4; c++) {
                    const barH = Math.min(perCat[c] / 3600, 1) * (h - 1);
                    if (barH < 0.5)
                        continue;
                    cr.setSourceRGBA(...CATEGORY_COLORS[c], 1);
                    cr.rectangle(hour * slot + gap / 2, y - barH, slot - gap, barH);
                    cr.fill();
                    y -= barH;
                }
            }
        }
        cr.$dispose();
    }
}

// ---------------------------------------------------------------- rectangle (2 x 1)

const TOP_APPS = 4;

export class RectCard {
    constructor() {
        this.actor = new St.BoxLayout({
            style_class: 'sct-card sct-rect',
            width: CELL * 2 + GAP,
            height: CELL,
        });

        const left = new St.BoxLayout({style_class: 'sct-rect-main', orientation: Clutter.Orientation.VERTICAL, x_expand: true});

        const header = new St.BoxLayout({style_class: 'sct-header'});
        const avatar = new St.Bin({style_class: 'sct-avatar', y_align: Clutter.ActorAlign.CENTER});
        avatar.set_child(new St.Icon({icon_name: 'avatar-default-symbolic', icon_size: 16}));
        this._avatar = avatar;
        this._watchAvatar();
        this._total = label('sct-total');
        header.add_child(avatar);
        header.add_child(this._total);
        left.add_child(header);

        const chartRow = new St.BoxLayout({y_expand: true});
        this._chart = new HourChart();
        chartRow.add_child(this._chart.actor);
        const axis = new St.BoxLayout({style_class: 'sct-axis', orientation: Clutter.Orientation.VERTICAL});
        for (const [text, align] of [['60m', Clutter.ActorAlign.START], ['30m', Clutter.ActorAlign.CENTER], ['0m', Clutter.ActorAlign.END]]) {
            const l = new St.Label({text, style_class: 'sct-axis-label', y_expand: true, y_align: align});
            axis.add_child(l);
        }
        chartRow.add_child(axis);
        left.add_child(chartRow);

        const xAxis = new St.BoxLayout({style_class: 'sct-xaxis'});
        for (const text of ['12 AM', '6 AM', '12 PM', '6 PM'])
            xAxis.add_child(new St.Label({text, style_class: 'sct-axis-label', x_expand: true}));
        left.add_child(xAxis);

        const right = new St.BoxLayout({style_class: 'sct-rect-side', orientation: Clutter.Orientation.VERTICAL, width: 100});
        this._rows = [];
        for (let i = 0; i < TOP_APPS; i++) {
            const row = new St.BoxLayout({style_class: 'sct-app-row', y_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const icon = appIcon(24);
            const time = label('sct-app-time');
            row.add_child(icon);
            row.add_child(time);
            right.add_child(row);
            this._rows.push({row, icon, time});
        }

        this.actor.add_child(left);
        this.actor.add_child(right);
    }

    // Show the account picture from AccountsService (what GNOME's own user menu uses),
    // falling back to the generic glyph if the user never set one.
    _watchAvatar() {
        this._user = null;
        this._userIds = [];
        try {
            this._user = AccountsService.UserManager.get_default().get_user(GLib.get_user_name());
        } catch (e) {
            console.warn(`screentime: no account picture: ${e.message}`);
            return;
        }
        const apply = () => {
            const path = this._user.get_icon_file();
            if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS))
                return;
            this._avatar.set_child(null);
            this._avatar.set_style(`background-image: url("file://${path}"); background-size: cover; background-color: transparent;`);
        };
        if (this._user.is_loaded)
            apply();
        else
            this._userIds.push(this._user.connect('notify::is-loaded', apply));
        this._userIds.push(this._user.connect('changed', apply));
    }

    destroy() {
        for (const id of this._userIds ?? [])
            this._user.disconnect(id);
        this._userIds = [];
    }

    update(summary, opts) {
        this._total.text = formatDuration(summary.total);
        this._chart.update(summary.hours, opts.dark);
        this._rows.forEach((r, i) => {
            const app = summary.apps[i];
            r.row.opacity = app ? 255 : 0;
            if (!app)
                return;
            setAppIcon(r.icon, app.id);
            r.time.text = formatDuration(app.secs);
        });
    }
}

// ---------------------------------------------------------------- square (1 x 1)

const TRACK_WIDTH = CELL - 32;

export class SquareCard {
    constructor() {
        this.actor = new St.BoxLayout({
            style_class: 'sct-card sct-square',
            orientation: Clutter.Orientation.VERTICAL,
            width: CELL,
            height: CELL,
        });

        this._title = label('sct-title', 'Screen Time');
        this._total = label('sct-big');
        const top = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        top.add_child(this._title);
        top.add_child(this._total);
        this.actor.add_child(top);

        const spacer = new St.Widget({y_expand: true});
        this.actor.add_child(spacer);

        const limitRow = new St.BoxLayout({style_class: 'sct-limit-row'});
        // One label that owns the whole row, so it can never collide with a neighbour.
        this._limitLeft = new St.Label({style_class: 'sct-small', x_expand: true});
        this._limitLeft.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        limitRow.add_child(this._limitLeft);
        this.actor.add_child(limitRow);

        this._track = new St.Widget({style_class: 'sct-track', width: TRACK_WIDTH, height: 6, layout_manager: new Clutter.BinLayout()});
        this._fill = new St.Widget({style_class: 'sct-fill', height: 6, x_align: Clutter.ActorAlign.START});
        this._track.add_child(this._fill);
        this.actor.add_child(this._track);

        const appRow = new St.BoxLayout({style_class: 'sct-top-app'});
        this._icon = appIcon(22);
        this._name = new St.Label({style_class: 'sct-app-name', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._time = label('sct-small');
        appRow.add_child(this._icon);
        appRow.add_child(this._name);
        appRow.add_child(this._time);
        this._appRow = appRow;
        this.actor.add_child(appRow);
    }

    update(summary, opts) {
        const limit = opts.limitMinutes * 60;
        this._total.text = formatDuration(summary.total);

        const over = summary.total > limit;
        this._limitLeft.text = over
            ? `Over limit by ${formatDuration(summary.total - limit)}`
            : `${formatDuration(limit - summary.total)} left of ${formatDuration(limit)} limit`;
        this._fill.width = Math.round(TRACK_WIDTH * Math.min(1, summary.total / limit));
        this._fill.style_class = over ? 'sct-fill sct-fill-over' : 'sct-fill';

        const top = summary.apps[0];
        this._appRow.opacity = top ? 255 : 0;
        if (top) {
            setAppIcon(this._icon, top.id);
            this._name.text = top.name;
            this._time.text = formatDuration(top.secs);
        }
    }
}
