#!/usr/bin/env -S gjs -m
// Screen Time — a small GTK4/libadwaita viewer for the data the Screen Time extension records.
// Run with:  gjs -m app/main.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import System from 'system';

import {
    UsageData, CATEGORIES, WEEKDAYS, WEEKDAYS_SHORT, MONTHS, MONTHS_SHORT,
    addDays, addMonths, startOfDay, startOfWeek, startOfMonth, daysInMonth, weekdayIndex,
    sameDay, hourLabel, formatDuration as fmt, appInfo,
} from './data.js';
import {C, HourStrip, WeekGrid, RingCalendar, RhythmClock, Heatmap, segmentBar, meter, sparkline} from './charts.js';

const APP_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const EXT_DIR = GLib.build_filenamev([APP_DIR, '..', 'screentime@local']);
const esc = s => GLib.markup_escape_text(s, -1);
const fmtM = s => esc(fmt(s)); // for tooltip markup

// "6h 05m" style, with two-digit minutes once there are hours.
const fmtPad = s => {
    const t = Math.round(s / 60);
    return t >= 60 ? `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}m` : fmt(s);
};

// ---------------------------------------------------------------- widget helpers

function clear(box) {
    let c;
    while ((c = box.get_first_child()))
        box.remove(c);
}

function label(text, classes = [], props = {}) {
    return new Gtk.Label({label: text, xalign: 0, css_classes: classes, ...props});
}

function vbox(spacing = 0, classes = [], props = {}) {
    return new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing, css_classes: classes, ...props});
}

function hbox(spacing = 0, classes = [], props = {}) {
    return new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing, css_classes: classes, ...props});
}

function spacer(vertical = true) {
    return new Gtk.Box({vexpand: vertical, hexpand: !vertical});
}

function card(props = {}) {
    return vbox(12, ['st-card'], props);
}

function cardHeader(title, right = null) {
    const row = hbox(8);
    row.append(label(title, ['st-h2'], {hexpand: true}));
    if (right)
        row.append(typeof right === 'string' ? label(right, ['st-muted', 'st-tiny'], {valign: Gtk.Align.BASELINE}) : right);
    return row;
}

function dot(color, size = 9) {
    const d = new Gtk.DrawingArea({content_width: size, content_height: size, valign: Gtk.Align.CENTER});
    const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
    d.set_draw_func((_a, cr, w, h) => {
        cr.setSourceRGBA(r, g, b, 1);
        cr.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    });
    return d;
}

function appIcon(id, size = 34) {
    const gicon = appInfo(id)?.get_icon();
    const img = gicon ? Gtk.Image.new_from_gicon(gicon) : Gtk.Image.new_from_icon_name('application-x-executable');
    img.pixel_size = size;
    img.valign = Gtk.Align.CENTER;
    return img;
}

// Big "2h 08m" with smaller, dimmer units.
function bigTime(seconds, size = 'st-big') {
    const box = hbox(0, [], {valign: Gtk.Align.END});
    const t = Math.round(seconds / 60);
    const h = Math.floor(t / 60), m = t % 60;
    const part = (v, unit) => {
        box.append(label(String(v), [size, 'st-num'], {valign: Gtk.Align.BASELINE_FILL}));
        box.append(label(unit, [`${size}-unit`], {valign: Gtk.Align.BASELINE_FILL, margin_end: 6}));
    };
    if (h > 0) {
        part(h, 'h');
        part(String(m).padStart(2, '0'), 'm');
    } else {
        part(m, 'm');
    }
    return box;
}

function tile(value, caption, classes = ['st-tile']) {
    const b = vbox(2, classes, {hexpand: true});
    b.append(label(value, ['st-tile-value', 'st-num'], {ellipsize: 3}));
    b.append(label(caption, ['st-muted', 'st-small']));
    return b;
}

function statCard(caption, value) {
    const b = vbox(4, ['st-card', 'st-stat'], {hexpand: true});
    b.append(label(caption.toUpperCase(), ['st-lbl']));
    b.append(label(value, ['st-stat-value', 'st-num'], {ellipsize: 3}));
    return b;
}

function catColor(c) {
    return CATEGORIES[c].color;
}

function peakHour(hours) {
    let best = -1;
    hours.forEach((v, h) => {
        if (v > 0 && (best < 0 || v > hours[best]))
            best = h;
    });
    return best;
}

const hourSpan = (a, b) => `${hourLabel(a)} – ${hourLabel(b % 24)}`;

function dayTip(day) {
    const lines = [`<b>${WEEKDAYS[weekdayIndex(day.date)]}, ${day.date.getDate()} ${MONTHS[day.date.getMonth()]}</b>`,
        day.total > 0 ? fmtM(day.total) : 'No screen time'];
    day.cats.forEach((s, c) => {
        if (s >= 60)
            lines.push(`<span foreground="${catColor(c)}">●</span> ${CATEGORIES[c].name}  ${fmtM(s)}`);
    });
    return lines.join('\n');
}

function topAppsIn(map, nameOf, n = 3) {
    return [...map].sort((a, b) => b[1] - a[1]).slice(0, n)
        .map(([id, s]) => `<span alpha="75%">${esc(nameOf(id))}</span>  ${fmtM(s)}`);
}

// One sentence about the shape of a day.
function dayInsight(agg) {
    const mins = agg.hours.map(s => s / 60);
    let best = null;
    for (let i = 0; i < 24;) {
        if (mins[i] < 10) {
            i++;
            continue;
        }
        let j = i;
        while (j < 24 && mins[j] >= 10)
            j++;
        const total = mins.slice(i, j).reduce((a, b) => a + b, 0);
        if (!best || total > best.total)
            best = {start: i, end: j, total};
        i = j;
    }
    if (!best)
        return agg.total > 0 ? 'A light day: no hour had more than 10 minutes on screen.' : 'Nothing recorded on this day.';
    const apps = new Map();
    for (let h = best.start; h < best.end; h++)
        for (const [id, s] of agg.hourApps[h])
            apps.set(id, (apps.get(id) ?? 0) + s);
    const [topId, topSecs] = [...apps].sort((a, b) => b[1] - a[1])[0];
    const share = Math.round((topSecs / (best.total * 60)) * 100);
    const span = `<b>${hourSpan(best.start, best.end)}</b>`;
    const lead = best.total * 60 >= agg.total * 0.6 ? `Most of this day was one block, ${span}.` : `Your longest stretch was ${span}.`;
    return `${lead} ${esc(agg.nameOf(topId))} took ${share}% of it.`;
}

// Average weekday x hour matrix (seconds per hour slot).
function avgWeekHeat(agg) {
    return agg.weekHeat.map((row, wd) => row.map(v => (agg.weekdayCount[wd] ? v / agg.weekdayCount[wd] : 0)));
}

// ---------------------------------------------------------------- tracking status (sidebar footer)

function trackingStatus() {
    let enabled = false;
    let idle = 120;
    try {
        const shell = new Gio.Settings({schema_id: 'org.gnome.shell'});
        enabled = shell.get_strv('enabled-extensions').includes('screentime@local') &&
            !shell.get_boolean('disable-user-extensions');
    } catch (_e) {
        // Not running under GNOME Shell.
    }
    try {
        const source = Gio.SettingsSchemaSource.new_from_directory(
            GLib.build_filenamev([EXT_DIR, 'schemas']), Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup('org.gnome.shell.extensions.screentime', false);
        if (schema)
            idle = new Gio.Settings({settings_schema: schema}).get_int('idle-seconds');
    } catch (_e) {
        // Keep the default.
    }
    return {enabled, idle};
}

// ---------------------------------------------------------------- window

const PAGES = [
    ['today', 'Today', 'st-today'],
    ['week', 'Week', 'st-week'],
    ['month', 'Month', 'st-month'],
    ['rhythm', 'Rhythm', 'st-rhythm'],
];

class ScreenTimeWindow {
    constructor(app) {
        this.data = new UsageData();
        this.date = startOfDay(new Date());
        this.page = 'today';

        this.win = new Adw.ApplicationWindow({
            application: app,
            title: 'Screen Time',
            default_width: 1120,
            default_height: 740,
            width_request: 960,
            height_request: 660,
            css_classes: ['st-window'],
        });

        // ---- sidebar
        this.nav = new Gtk.ListBox({css_classes: ['navigation-sidebar', 'st-nav'], selection_mode: Gtk.SelectionMode.SINGLE});
        this.rows = {};
        for (const [name, title, icon] of PAGES) {
            const row = new Gtk.ListBoxRow();
            const box = hbox(10);
            box.append(Gtk.Image.new_from_file(GLib.build_filenamev([APP_DIR, 'icons', `${icon}.svg`])));
            box.append(label(title));
            row.child = box;
            row._page = name;
            this.rows[name] = row;
            this.nav.append(row);
        }
        this.nav.connect('row-selected', (_l, row) => {
            if (row && row._page !== this.page) {
                this.page = row._page;
                this.render();
            }
        });

        const sideBox = vbox(0, [], {vexpand: true});
        sideBox.append(label('SCREEN TIME', ['st-lbl'], {margin_start: 22, margin_bottom: 6, margin_top: 4}));
        sideBox.append(this.nav);
        sideBox.append(spacer());
        this.status = vbox(4, ['st-status']);
        sideBox.append(this.status);

        const sideView = new Adw.ToolbarView({content: sideBox});
        const sideHeader = new Adw.HeaderBar({show_end_title_buttons: false, title_widget: new Gtk.Box()});
        sideView.add_top_bar(sideHeader);
        const sidebar = new Adw.NavigationPage({title: 'Screen Time', child: sideView, css_classes: ['st-sidebar']});

        // ---- content
        this.stack = new Gtk.Stack({transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 120});
        this.pages = {};
        for (const [name] of PAGES) {
            const content = vbox(14, ['st-page'], {vexpand: true});
            const scroll = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, child: content});
            this.pages[name] = {content, scroll};
            this.stack.add_named(scroll, name);
        }

        const header = new Adw.HeaderBar({show_start_title_buttons: false, title_widget: new Gtk.Box()});
        this.prevBtn = new Gtk.Button({icon_name: 'go-previous-symbolic', tooltip_text: 'Previous (Alt+←)', css_classes: ['st-navbtn'], valign: Gtk.Align.CENTER});
        this.nextBtn = new Gtk.Button({icon_name: 'go-next-symbolic', tooltip_text: 'Next (Alt+→)', css_classes: ['st-navbtn'], valign: Gtk.Align.CENTER});
        this.prevBtn.connect('clicked', () => this.step(-1));
        this.nextBtn.connect('clicked', () => this.step(1));
        this.titleLabel = label('', ['st-title'], {valign: Gtk.Align.CENTER});
        this.subLabel = label('', ['st-muted', 'st-subtitle'], {valign: Gtk.Align.CENTER});
        this.todayBtn = new Gtk.Button({label: 'Today', css_classes: ['st-pill'], valign: Gtk.Align.CENTER});
        this.todayBtn.connect('clicked', () => this.goTo(startOfDay(new Date())));
        const navBox = hbox(6, [], {margin_start: 8});
        navBox.append(this.prevBtn);
        navBox.append(this.nextBtn);
        header.pack_start(navBox);
        const titles = hbox(10, [], {margin_start: 6});
        titles.append(this.titleLabel);
        titles.append(this.subLabel);
        header.pack_start(titles);
        header.pack_end(this.todayBtn);

        const contentView = new Adw.ToolbarView({content: this.stack});
        contentView.add_top_bar(header);
        const contentPage = new Adw.NavigationPage({title: 'Today', child: contentView, css_classes: ['st-content']});

        this.split = new Adw.NavigationSplitView({
            sidebar, content: contentPage,
            min_sidebar_width: 210, max_sidebar_width: 210, sidebar_width_fraction: 0.2,
        });
        this.win.content = this.split;

        this._keys();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT_IDLE, 60, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this.win.connect('close-request', () => {
            GLib.source_remove(this._timer);
            return false;
        });

        this.nav.select_row(this.rows.today);
        this.render();
    }

    _keys() {
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, _code, state) => {
            const ctrl = state & Gdk.ModifierType.CONTROL_MASK;
            if (ctrl && keyval === Gdk.KEY_r) {
                this.refresh();
                return true;
            }
            if (ctrl && (keyval === Gdk.KEY_q || keyval === Gdk.KEY_w)) {
                this.win.close();
                return true;
            }
            if (state & Gdk.ModifierType.ALT_MASK) {
                if (keyval === Gdk.KEY_Left)
                    this.step(-1);
                else if (keyval === Gdk.KEY_Right)
                    this.step(1);
                else if (keyval >= Gdk.KEY_1 && keyval <= Gdk.KEY_4)
                    this.nav.select_row(this.rows[PAGES[keyval - Gdk.KEY_1][0]]);
                else
                    return false;
                return true;
            }
            return false;
        });
        this.win.add_controller(keys);
    }

    show(page) {
        this.nav.select_row(this.rows[page]); // renders via row-selected
    }

    goTo(date, page = null) {
        this.date = startOfDay(date);
        if (page && page !== this.page)
            this.show(page);
        else
            this.render();
    }

    step(dir) {
        const d = this.date;
        const next = this.page === 'today' ? addDays(d, dir) : this.page === 'week' ? addDays(d, 7 * dir) : addMonths(d, dir);
        const today = startOfDay(new Date());
        this.goTo(next > today ? today : next < this.data.firstDate ? this.data.firstDate : next);
    }

    refresh() {
        this.data.reload();
        const scroll = this.pages[this.page].scroll;
        const pos = scroll.vadjustment.value;
        this.render();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            scroll.vadjustment.value = pos;
            return GLib.SOURCE_REMOVE;
        });
    }

    _period() {
        if (this.page === 'week') {
            const s = startOfWeek(this.date);
            return [s, addDays(s, 6)];
        }
        if (this.page === 'month') {
            const s = startOfMonth(this.date);
            return [s, addDays(s, daysInMonth(s) - 1)];
        }
        return [this.date, this.date];
    }

    _updateHeader(title, subtitle) {
        this.titleLabel.label = title;
        this.subLabel.label = subtitle ?? '';
        const today = startOfDay(new Date());
        const nav = this.page !== 'rhythm';
        this.prevBtn.visible = this.nextBtn.visible = nav;
        const [s, e] = this._period();
        this.nextBtn.sensitive = e < today;
        this.prevBtn.sensitive = s > this.data.firstDate;
        this.todayBtn.visible = nav && !(today >= s && today <= e);
    }

    _renderStatus() {
        clear(this.status);
        const {enabled, idle} = trackingStatus();
        const head = hbox(8);
        head.append(dot(enabled ? '#30D158' : '#FF453A', 8));
        head.append(label(enabled ? 'Tracking on' : 'Tracking off', ['st-status-title']));
        this.status.append(head);
        const idleText = idle % 60 === 0 ? `${idle / 60} min` : `${idle} s`;
        this.status.append(label(enabled
            ? `Pauses after ${idleText} idle. Stays on this laptop.`
            : 'Turn on the Screen Time extension to record usage.', ['st-muted', 'st-tiny'], {wrap: true, max_width_chars: 22}));
    }

    render() {
        this.stack.visible_child_name = this.page;
        this._renderStatus();
        const {content} = this.pages[this.page];
        clear(content);
        if (this.data.isEmpty) {
            this._updateHeader('Screen Time', '');
            content.append(new Adw.StatusPage({
                icon_name: 'preferences-system-time-symbolic',
                title: 'No screen time yet',
                description: 'Turn on the Screen Time extension. Usage shows up here within a minute.',
                vexpand: true,
            }));
            return;
        }
        ({today: () => this.renderToday(content), week: () => this.renderWeek(content),
            month: () => this.renderMonth(content), rhythm: () => this.renderRhythm(content)})[this.page]();
    }

    // ------------------------------------------------------------ app rows

    _appRow(app, {top, total, spark}) {
        const r = hbox(12, ['st-app-row']);
        r.append(appIcon(app.id));
        const mid = vbox(5, [], {hexpand: true, valign: Gtk.Align.CENTER});
        const line = hbox(8);
        line.append(label(app.name, ['st-app-name'], {hexpand: true, ellipsize: 3}));
        line.append(label(CATEGORIES[app.cat].name, ['st-muted', 'st-tiny']));
        mid.append(line);
        mid.append(meter(app.secs / top, catColor(app.cat)));
        r.append(mid);
        if (spark)
            r.append(sparkline(spark, catColor(app.cat)));
        r.append(label(fmt(app.secs), ['st-app-time', 'st-num'], {xalign: 1, width_chars: 7, valign: Gtk.Align.CENTER}));
        const pct = total > 0 ? Math.round((app.secs / total) * 100) : 0;
        r.tooltip_text = `${app.name} · ${pct}% of the day`;
        return r;
    }

    _allAppsButton(agg, shown) {
        const btn = new Gtk.MenuButton({child: new Gtk.Label({label: `Show all ${agg.apps.length}`}), css_classes: ['st-link'], valign: Gtk.Align.CENTER});
        if (agg.apps.length <= shown) {
            btn.visible = false;
            return btn;
        }
        const list = vbox(10, [], {margin_top: 10, margin_bottom: 10, margin_start: 12, margin_end: 12});
        const top = agg.apps[0].secs;
        agg.apps.forEach(a => {
            const r = hbox(10);
            r.append(appIcon(a.id, 24));
            const mid = vbox(4, [], {hexpand: true, valign: Gtk.Align.CENTER});
            mid.append(label(a.name, ['st-small'], {ellipsize: 3}));
            mid.append(meter(a.secs / top, catColor(a.cat), 4));
            r.append(mid);
            r.append(label(fmt(a.secs), ['st-small', 'st-num'], {width_chars: 7, xalign: 1}));
            list.append(r);
        });
        const scroll = new Gtk.ScrolledWindow({child: list, propagate_natural_height: true, max_content_height: 420, min_content_width: 320, hscrollbar_policy: Gtk.PolicyType.NEVER});
        btn.popover = new Gtk.Popover({child: scroll});
        return btn;
    }

    _categoryRows(agg, box, {compact = false} = {}) {
        const parts = CATEGORIES.map((c, i) => ({i, name: c.name, color: c.color, value: agg.cats[i]}))
            .filter(p => p.value > 0 || !compact)
            .sort((a, b) => b.value - a.value);
        box.append(segmentBar(parts, compact ? 8 : 10));
        if (compact) {
            const grid = new Gtk.Grid({column_spacing: 12, row_spacing: 6, column_homogeneous: true});
            parts.forEach((p, k) => {
                const r = hbox(6);
                r.append(dot(p.color, 8));
                r.append(label(p.name, ['st-small', 'st-soft'], {hexpand: true}));
                r.append(label(`${agg.total ? Math.round(p.value / agg.total * 100) : 0}%`, ['st-small', 'st-muted', 'st-num']));
                grid.attach(r, k % 2, Math.floor(k / 2), 1, 1);
            });
            box.append(grid);
            return;
        }
        parts.forEach(p => {
            const r = hbox(10, ['st-cat-row']);
            r.append(dot(p.color));
            r.append(label(p.name, ['st-body'], {hexpand: true}));
            r.append(label(`${agg.total ? Math.round(p.value / agg.total * 100) : 0}%`, ['st-muted', 'st-num', 'st-body']));
            r.append(label(fmt(p.value), ['st-strong', 'st-num', 'st-body'], {width_chars: 7, xalign: 1}));
            box.append(r);
        });
    }

    // ------------------------------------------------------------ Today

    renderToday(content) {
        const date = this.date;
        const today = startOfDay(new Date());
        const agg = this.data.range(date, 1);
        const prev = this.data.range(addDays(date, -7), 7);
        const avg = prev.active ? prev.total / prev.active : 0;

        const rel = sameDay(date, today) ? 'Today' : sameDay(date, addDays(today, -1)) ? 'Yesterday' : WEEKDAYS[weekdayIndex(date)];
        this._updateHeader(rel, `${WEEKDAYS[weekdayIndex(date)]}, ${date.getDate()} ${MONTHS[date.getMonth()]}${date.getFullYear() !== today.getFullYear() ? ` ${date.getFullYear()}` : ''}`);

        // ---- hero
        const hero = card({spacing: 18});
        const top = hbox(24);
        const left = vbox(4, [], {hexpand: true, valign: Gtk.Align.END});
        left.append(label('SCREEN TIME', ['st-lbl']));
        left.append(bigTime(agg.total));
        let delta = '';
        if (avg > 0) {
            const diff = agg.total - avg;
            delta = Math.abs(diff) < 300 ? 'Right on your daily average' : `${fmtPad(Math.abs(diff))} ${diff < 0 ? 'under' : 'over'} your daily average`;
        }
        left.append(label(delta || 'Not enough history for an average yet', ['st-muted', 'st-body']));
        top.append(left);
        const active = agg.hours.map((v, h) => (v >= 60 ? h : -1)).filter(h => h >= 0);
        const peak = peakHour(agg.hours);
        const tiles = hbox(12, [], {homogeneous: true, width_request: 390, valign: Gtk.Align.END});
        tiles.append(tile(peak >= 0 ? hourLabel(peak) : '—', 'Busiest hour'));
        tiles.append(tile(active.length ? hourLabel(active[0]) : '—', 'Day started'));
        tiles.append(tile(String(agg.apps.length), 'Apps opened'));
        top.append(tiles);
        hero.append(top);

        const stripBox = vbox(8);
        stripBox.append(cardHeader('Hour by hour', 'Fill = share of the hour on screen'));
        const strip = new HourStrip();
        strip.set(agg.hours.map(s => s / 60), h => {
            const lines = [`<b>${hourSpan(h, h + 1)}</b>`, agg.hours[h] > 0 ? fmtM(agg.hours[h]) : 'Nothing'];
            return lines.concat(topAppsIn(agg.hourApps[h], agg.nameOf)).join('\n');
        });
        stripBox.append(strip.widget);
        const axis = hbox(0, [], {homogeneous: true});
        ['12 AM', '6 AM', '12 PM', '6 PM'].forEach(t => axis.append(label(t, ['st-muted', 'st-tiny'])));
        stripBox.append(axis);
        hero.append(stripBox);
        content.append(hero);

        // ---- apps + categories
        const row = hbox(14, [], {vexpand: true});
        const apps = card({hexpand: true, spacing: 8});
        const SHOWN = 5;
        apps.append(cardHeader('Apps', this._allAppsButton(agg, SHOWN)));
        if (!agg.apps.length)
            apps.append(label('No apps recorded on this day.', ['st-muted']));
        const week = this.data.range(addDays(date, -6), 7);
        agg.apps.slice(0, SHOWN).forEach(a => apps.append(this._appRow(a, {
            top: agg.apps[0].secs, total: agg.total,
            spark: week.days.map(d => d.apps.get(a.id) ?? 0),
        })));
        row.append(apps);

        const where = card({width_request: 330});
        where.append(cardHeader('Where it went'));
        this._categoryRows(agg, where);
        where.append(spacer());
        where.append(label(dayInsight(agg), ['st-insight'], {use_markup: true, wrap: true, xalign: 0}));
        row.append(where);
        content.append(row);
    }

    // ------------------------------------------------------------ Week

    renderWeek(content) {
        const start = startOfWeek(this.date);
        const end = addDays(start, 6);
        const today = startOfDay(new Date());
        const agg = this.data.range(start, 7);
        const isCurrent = today >= start && today <= end;
        const span = start.getMonth() === end.getMonth()
            ? `${start.getDate()} – ${end.getDate()} ${MONTHS[end.getMonth()]}`
            : `${start.getDate()} ${MONTHS_SHORT[start.getMonth()]} – ${end.getDate()} ${MONTHS_SHORT[end.getMonth()]}`;
        this._updateHeader(isCurrent ? 'This week' : sameDay(start, addDays(startOfWeek(today), -7)) ? 'Last week' : 'Week', span);

        const heaviest = agg.days.reduce((a, d) => (d.total > a.total ? d : a), agg.days[0]);
        const late = agg.days.reduce((a, d) => a + d.hours.slice(0, 5).reduce((x, y) => x + y, 0), 0);
        const stats = hbox(12, [], {homogeneous: true});
        stats.append(statCard('Total', fmtPad(agg.total)));
        stats.append(statCard('Per active day', agg.active ? fmtPad(agg.total / agg.active) : '—'));
        stats.append(statCard('Heaviest day', heaviest.total > 0 ? WEEKDAYS[weekdayIndex(heaviest.date)] : '—'));
        stats.append(statCard('Midnight – 5 AM', agg.total ? `${Math.round(late / agg.total * 100)}%` : '—'));
        content.append(stats);

        const row = hbox(14, [], {vexpand: true});
        const cal = card({hexpand: true, spacing: 10});
        cal.append(cardHeader('The week as a calendar', 'Brighter = more of that hour · click a day'));
        const future = agg.days.findIndex(d => d.date > today);
        const grid = new WeekGrid({onActivate: i => this.goTo(agg.days[i].date, 'today')});
        grid.set(agg.days.map(d => ({
            name: `${WEEKDAYS_SHORT[weekdayIndex(d.date)]} ${d.date.getDate()}`,
            total: d.date > today ? '—' : fmt(d.total),
            mins: d.hours.map(s => s / 60),
        })), {
            selected: agg.days.findIndex(d => sameDay(d.date, today)),
            future: future < 0 ? 7 : future,
            tip: (c, h) => {
                const d = agg.days[c];
                return [`<b>${WEEKDAYS[weekdayIndex(d.date)]} ${d.date.getDate()}, ${hourSpan(h, h + 1)}</b>`,
                    d.hours[h] > 0 ? fmtM(d.hours[h]) : 'Nothing'].join('\n');
            },
        });
        cal.append(grid.widget);
        row.append(cal);

        const side = card({width_request: 330, spacing: 12});
        side.append(cardHeader('Top apps', this._allAppsButton(agg, 5)));
        const top = agg.apps[0]?.secs ?? 1;
        agg.apps.slice(0, 5).forEach(a => {
            const item = vbox(6);
            const line = hbox(8);
            line.append(dot(catColor(a.cat)));
            line.append(label(a.name, ['st-app-name'], {hexpand: true, ellipsize: 3}));
            line.append(label(fmtPad(a.secs), ['st-strong', 'st-num', 'st-body']));
            item.append(line);
            item.append(meter(a.secs / top, catColor(a.cat), 8));
            side.append(item);
        });
        if (!agg.apps.length)
            side.append(label('No apps recorded this week.', ['st-muted']));
        side.append(spacer());
        side.append(new Gtk.Box({css_classes: ['st-sep']}));
        side.append(label('CATEGORIES', ['st-lbl']));
        this._categoryRows(agg, side, {compact: true});
        row.append(side);
        content.append(row);
    }

    // ------------------------------------------------------------ Month

    renderMonth(content) {
        const start = startOfMonth(this.date);
        const n = daysInMonth(start);
        const today = startOfDay(new Date());
        const agg = this.data.range(start, n);
        const isCurrent = today.getFullYear() === start.getFullYear() && today.getMonth() === start.getMonth();
        const first = this.data.firstDate;
        const since = first > start && first <= addDays(start, n - 1) ? `Tracking since ${first.getDate()} ${MONTHS_SHORT[first.getMonth()]}` : (isCurrent ? 'This month so far' : '');
        this._updateHeader(`${MONTHS[start.getMonth()]} ${start.getFullYear()}`, since);

        const row = hbox(14, [], {vexpand: true});
        const cal = card({hexpand: true, spacing: 10});
        cal.append(cardHeader('Every day, as a ring', 'Full ring = 12 hours · click a day'));
        const rings = new RingCalendar({onActivate: d => this.goTo(agg.days[d].date, 'today')});
        const futureIdx = isCurrent ? today.getDate() : (start > today ? 0 : n);
        rings.set(weekdayIndex(start), agg.days.map(d => d.total), {
            today: isCurrent ? today.getDate() - 1 : -1,
            future: futureIdx,
            tip: d => dayTip(agg.days[d]),
            label: d => (d >= futureIdx ? '' : agg.days[d].total > 0 ? fmt(agg.days[d].total) : '—'),
        });
        cal.append(rings.widget);
        row.append(cal);

        const side = vbox(14, [], {width_request: 330});
        const total = card({spacing: 4});
        total.append(label('THIS MONTH', ['st-lbl']));
        total.append(bigTime(agg.total, 'st-mid'));
        total.append(label(agg.active ? `${agg.active} tracked day${agg.active === 1 ? '' : 's'} · ${fmtPad(agg.total / agg.active)} a day` : 'Nothing tracked this month', ['st-muted', 'st-small']));
        side.append(total);

        const tracked = agg.days.filter(d => d.total >= 60);
        const longest = tracked.reduce((a, d) => (!a || d.total > a.total ? d : a), null);
        const lightest = tracked.reduce((a, d) => (!a || d.total < a.total ? d : a), null);
        const dayName = d => `${WEEKDAYS_SHORT[weekdayIndex(d.date)]} ${d.date.getDate()}`;
        const rec = vbox(0, ['st-card', 'st-records']);
        const recRow = (k, v, last = false) => {
            const r = hbox(8, last ? ['st-rec'] : ['st-rec', 'st-rec-line']);
            r.append(label(k, ['st-muted', 'st-body'], {hexpand: true}));
            r.append(label(v, ['st-strong', 'st-num', 'st-body'], {ellipsize: 3}));
            rec.append(r);
        };
        recRow('Longest day', longest ? `${dayName(longest)} · ${fmtPad(longest.total)}` : '—');
        recRow('Lightest day', lightest ? `${dayName(lightest)} · ${fmtPad(lightest.total)}` : '—');
        recRow('Top app', agg.apps[0]?.name ?? '—');
        recRow('Apps used', String(agg.apps.length), true);
        side.append(rec);

        const cats = card({vexpand: true, spacing: 10});
        cats.append(cardHeader('By category'));
        const maxCat = Math.max(...agg.cats, 1);
        CATEGORIES.map((c, i) => ({c, v: agg.cats[i]})).sort((a, b) => b.v - a.v).forEach(({c, v}) => {
            const item = vbox(5);
            const line = hbox(8);
            line.append(label(c.name, ['st-body'], {hexpand: true}));
            line.append(label(fmtPad(v), ['st-strong', 'st-num', 'st-body']));
            item.append(line);
            item.append(meter(v / maxCat, c.color, 6));
            cats.append(item);
        });
        side.append(cats);
        row.append(side);
        content.append(row);
    }

    // ------------------------------------------------------------ Rhythm

    renderRhythm(content) {
        const today = startOfDay(new Date());
        const first = this.data.firstDate;
        const nDays = Math.round((today - first) / 86400000) + 1;
        const all = this.data.range(first, nDays);
        this._updateHeader('Your rhythm', `All tracked days since ${first.getDate()} ${MONTHS_SHORT[first.getMonth()]}`);

        const activeDays = Math.max(1, all.active);
        const perHour = all.hours.map(s => s / activeDays);

        const row = hbox(14);
        const clockCard = card({width_request: 290, hexpand: false, spacing: 6});
        clockCard.append(cardHeader('The average day'));
        const clock = new RhythmClock();
        clock.set(perHour, fmtPad(all.total / activeDays), 'per active day',
            h => `<b>${hourSpan(h, h + 1)}</b>\n${fmtM(perHour[h])} on an average day`);
        clockCard.append(clock.widget);
        row.append(clockCard);

        // Facts, all computed from the data.
        const total = all.total || 1;
        const night = [21, 22, 23, 0, 1, 2, 3].reduce((a, h) => a + all.hours[h], 0);
        const peak = peakHour(all.hours);
        const quietMax = Math.max(...all.hours) * 0.01;
        let quiet = null;
        for (let s = 0; s < 24; s++) {
            if (all.hours[s] > quietMax || all.hours[(s + 23) % 24] <= quietMax)
                continue; // only start at the first quiet hour after a busy one
            let len = 0;
            while (len < 24 && all.hours[(s + len) % 24] <= quietMax)
                len++;
            if (len < 24 && (!quiet || len > quiet.len))
                quiet = {s, len};
        }
        const wdAvg = all.weekHeat.map((r, wd) => r.reduce((a, b) => a + b, 0) / Math.max(1, all.weekdayCount[wd]));
        const heavyWd = wdAvg.indexOf(Math.max(...wdAvg));

        const facts = new Gtk.Grid({column_spacing: 14, row_spacing: 14, column_homogeneous: true, row_homogeneous: true, hexpand: true});
        const fact = (k, v, note, i) => {
            const b = vbox(4, ['st-card', 'st-fact']);
            b.append(label(k.toUpperCase(), ['st-lbl']));
            b.append(label(v, ['st-fact-value', 'st-num']));
            b.append(label(note, ['st-muted', 'st-small'], {wrap: true}));
            facts.attach(b, i % 2, Math.floor(i / 2), 1, 1);
        };
        fact('9 PM – 4 AM', `${Math.round(night / total * 100)}%`, 'of your screen time is late at night.', 0);
        fact('Busiest hour', peak >= 0 ? hourLabel(peak) : '—', 'The hour you are most often on screen.', 1);
        fact('Quiet hours', quiet ? hourSpan(quiet.s, quiet.s + quiet.len).replace(' AM – ', ' – ').replace(/^(\d+) PM – (\d+ PM)$/, '$1 – $2') : 'None',
            quiet ? 'Almost nothing tracked in this window.' : 'Every hour has some screen time.', 2);
        fact('Heaviest day', wdAvg[heavyWd] > 0 ? WEEKDAYS[heavyWd] : '—', wdAvg[heavyWd] > 0 ? `${fmtPad(wdAvg[heavyWd])} on an average ${WEEKDAYS[heavyWd]}.` : '', 3);
        row.append(facts);
        content.append(row);

        const heat = card({vexpand: true, spacing: 10});
        const legend = hbox(6, [], {valign: Gtk.Align.CENTER});
        legend.append(label('Less', ['st-muted', 'st-tiny']));
        [[C.fill, 1], [C.accent, 0.4], [C.accent, 0.7], [C.accent, 1]].forEach(([c, a]) => {
            const sq = new Gtk.DrawingArea({content_width: 12, content_height: 12, valign: Gtk.Align.CENTER});
            const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255);
            sq.set_draw_func((_a, cr, w, h) => {
                cr.setSourceRGBA(r, g, b, a);
                cr.rectangle(0, 0, w, h);
                cr.fill();
                cr.$dispose();
            });
            sq.add_css_class('st-legend');
            legend.append(sq);
        });
        legend.append(label('More', ['st-muted', 'st-tiny']));
        heat.append(cardHeader('When you are on your laptop', legend));
        const hm = new Heatmap();
        const matrix = avgWeekHeat(all);
        hm.set(matrix, WEEKDAYS_SHORT, (r, h) => `<b>${WEEKDAYS[r]}s, ${hourSpan(h, h + 1)}</b>\n${fmtM(matrix[r][h])} on average`);
        heat.append(hm.widget);
        content.append(heat);
    }
}

// ---------------------------------------------------------------- app

const CSS = `
window.st-window { background-color: #000000; }
.st-sidebar, .st-sidebar headerbar { background-color: #161618; }
.st-sidebar { border-right: 1px solid #2C2C2E; }
.st-content, .st-content headerbar { background-color: #000000; }
headerbar { box-shadow: none; min-height: 52px; }
.st-content headerbar { border-bottom: 1px solid #1C1C1E; }
.st-nav { background: transparent; padding: 0 10px; }
.st-nav row { border-radius: 8px; min-height: 34px; padding: 0 10px; margin: 1px 0; color: #D1D1D6; font-weight: 500; }
.st-nav row:hover { background-color: #2C2C2E; }
.st-nav row:selected { background-color: #0A84FF; color: #FFFFFF; }
.st-status { margin: 12px; padding: 12px; border-radius: 10px; background-color: #1C1C1E; }
.st-status-title { font-size: 12px; font-weight: 600; }
.st-page { padding: 18px 20px 20px 20px; }
.st-card { background-color: #1C1C1E; border-radius: 14px; padding: 18px 20px; }
.st-stat { padding: 14px 16px; }
.st-stat-value { font-size: 24px; font-weight: 700; }
.st-fact { padding: 16px 18px; }
.st-fact-value { font-size: 26px; font-weight: 700; }
.st-tile { background-color: #2C2C2E; border-radius: 10px; padding: 10px 12px; }
.st-tile-value { font-size: 18px; font-weight: 700; }
.st-lbl { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; color: #98989F; }
.st-muted { color: #98989F; }
.st-soft { color: #D1D1D6; }
.st-strong { font-weight: 600; }
.st-body { font-size: 13px; }
.st-small { font-size: 12px; }
.st-tiny { font-size: 11px; }
.st-h2 { font-size: 15px; font-weight: 700; }
.st-title { font-size: 17px; font-weight: 700; }
.st-subtitle { font-size: 13px; }
.st-big { font-size: 52px; font-weight: 700; letter-spacing: -1px; }
.st-big-unit { font-size: 26px; font-weight: 600; color: #98989F; }
.st-mid { font-size: 38px; font-weight: 700; letter-spacing: -0.5px; }
.st-mid-unit { font-size: 20px; font-weight: 600; color: #98989F; }
.st-num { font-feature-settings: "tnum"; }
.st-app-row { min-height: 46px; }
.st-app-name { font-size: 13px; font-weight: 600; }
.st-app-time { font-size: 14px; font-weight: 600; }
.st-cat-row { min-height: 22px; }
.st-insight { background-color: #2C2C2E; border-radius: 10px; padding: 12px 14px; color: #D1D1D6; font-size: 12px; }
.st-records { padding-top: 8px; padding-bottom: 8px; }
.st-rec { min-height: 32px; }
.st-rec-line { border-bottom: 1px solid #2C2C2E; }
.st-sep { background-color: #2C2C2E; min-height: 1px; }
.st-legend { border-radius: 3px; }
.st-navbtn { min-width: 32px; min-height: 32px; padding: 0; border-radius: 8px; background-color: #2C2C2E; }
.st-pill { min-height: 28px; padding: 0 12px; border-radius: 8px; background-color: #2C2C2E; font-weight: 600; }
menubutton.st-link > button { color: #0A84FF; font-size: 12px; font-weight: 600; background: none; padding: 2px 6px; min-height: 0; }
`;

const app = new Adw.Application({application_id: 'io.github.screentime.App', flags: Gio.ApplicationFlags.DEFAULT_FLAGS});
let mainWindow = null;
app.connect('startup', () => {
    Adw.StyleManager.get_default().color_scheme = Adw.ColorScheme.FORCE_DARK;
    const provider = new Gtk.CssProvider();
    provider.load_from_string(CSS);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).add_search_path(APP_DIR);
    Gtk.Window.set_default_icon_name('io.github.screentime.App');
});
app.connect('activate', () => {
    mainWindow ??= new ScreenTimeWindow(app);
    mainWindow.win.present();
    const shotDir = GLib.getenv('SCREENTIME_SCREENSHOTS');
    if (shotDir)
        saveScreenshots(mainWindow, shotDir);
});

// Development aid: SCREENTIME_SCREENSHOTS=/some/dir renders every page to PNG, then quits.
function saveScreenshots(w, dir) {
    const pages = PAGES.map(p => p[0]);
    const shoot = () => {
        const name = pages.shift();
        if (!name) {
            app.quit();
            return GLib.SOURCE_REMOVE;
        }
        w.show(name);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            const width = w.win.get_width(), height = w.win.get_height();
            const snap = new Gtk.Snapshot();
            new Gtk.WidgetPaintable({widget: w.win}).snapshot(snap, width, height);
            const tex = w.win.get_renderer().render_texture(snap.to_node(), null);
            tex?.save_to_png(GLib.build_filenamev([dir, `${name}.png`]));
            shoot();
            return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
    };
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, shoot);
}

app.run([System.programInvocationName, ...ARGV]);
