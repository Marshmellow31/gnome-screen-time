// Reads the per-day JSON files the extension writes to ~/.local/share/screentime/
// ({hours: [{appId: seconds} x 24], names: {appId: name}}) and aggregates them.
// Files are re-parsed only when their modification time changes.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';

export const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'screentime']);

// ---------------------------------------------------------------- dates

const pad = n => String(n).padStart(2, '0');
export const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseKey = k => {
    const [y, m, d] = k.split('-').map(Number);
    return new Date(y, m - 1, d);
};
export const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
export const weekdayIndex = d => (d.getDay() + 6) % 7; // Monday = 0
export const startOfWeek = d => addDays(startOfDay(d), -weekdayIndex(d));
export const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
export const daysInMonth = d => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
export const sameDay = (a, b) => keyOf(a) === keyOf(b);

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const WEEKDAYS_SHORT = WEEKDAYS.map(w => w.slice(0, 3));
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
export const MONTHS_SHORT = MONTHS.map(m => m.slice(0, 3));

export function hourLabel(h, short = false) {
    const suffix = h < 12 ? (short ? 'a' : ' AM') : (short ? 'p' : ' PM');
    return `${h % 12 === 0 ? 12 : h % 12}${suffix}`;
}

export function formatDuration(seconds) {
    if (seconds < 60)
        return seconds > 0 ? '<1m' : '0m';
    const total = Math.round(seconds / 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h === 0)
        return `${m}m`;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ---------------------------------------------------------------- categories

// Same buckets as the desktop widget, in Apple's dark-mode system colors.
export const CATEGORIES = [
    {name: 'Development', color: '#0A84FF'},
    {name: 'Browsing', color: '#64D2FF'},
    {name: 'Social', color: '#FF9F0A'},
    {name: 'Other', color: '#8E8E93'},
];
const DEVELOP = ['Development', 'IDE', 'TerminalEmulator', 'TextEditor'];
const BROWSE = ['WebBrowser'];
const SOCIAL = ['InstantMessaging', 'Chat', 'Email', 'Network', 'VideoConference', 'Telephony'];

const infoCache = new Map();
export function appInfo(id) {
    if (!infoCache.has(id)) {
        let info = null;
        try {
            info = GioUnix.DesktopAppInfo.new(id);
        } catch (_e) {
            info = null;
        }
        infoCache.set(id, info);
    }
    return infoCache.get(id);
}

const catCache = new Map();
export function categoryOf(id) {
    if (!catCache.has(id)) {
        const cats = (appInfo(id)?.get_categories() ?? '').split(';');
        let c = 3;
        if (cats.some(x => DEVELOP.includes(x)))
            c = 0;
        else if (cats.some(x => BROWSE.includes(x)))
            c = 1;
        else if (cats.some(x => SOCIAL.includes(x)))
            c = 2;
        catCache.set(id, c);
    }
    return catCache.get(id);
}

// ---------------------------------------------------------------- store

const zeros = n => new Array(n).fill(0);

export class UsageData {
    constructor(dir = DATA_DIR) {
        this._dir = dir;
        this._days = new Map(); // key -> {hours, names}
        this._mtimes = new Map();
        this.reload();
    }

    reload() {
        const seen = new Set();
        try {
            const dir = Gio.File.new_for_path(this._dir);
            const en = dir.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)) !== null) {
                const name = info.get_name();
                if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name))
                    continue;
                const key = name.slice(0, 10);
                seen.add(key);
                const mtime = info.get_modification_date_time()?.to_unix() ?? 0;
                if (this._mtimes.get(key) === mtime)
                    continue;
                this._mtimes.set(key, mtime);
                this._days.set(key, this._parse(GLib.build_filenamev([this._dir, name])));
            }
            en.close(null);
        } catch (_e) {
            // No data directory yet: the extension has not recorded anything.
        }
        for (const key of [...this._days.keys()]) {
            if (!seen.has(key)) {
                this._days.delete(key);
                this._mtimes.delete(key);
            }
        }
        this._sortedKeys = [...this._days.keys()].filter(k => this._days.get(k)).sort();
    }

    _parse(path) {
        try {
            const [, bytes] = GLib.file_get_contents(path);
            const day = JSON.parse(new TextDecoder().decode(bytes));
            if (!day || !Array.isArray(day.hours) || day.hours.length !== 24)
                return null;
            day.hours = day.hours.map(b => (b && typeof b === 'object' && !Array.isArray(b) ? b : {}));
            day.names ??= {};
            return day;
        } catch (_e) {
            return null;
        }
    }

    get firstDate() {
        return this._sortedKeys.length ? parseKey(this._sortedKeys[0]) : startOfDay(new Date());
    }

    get isEmpty() {
        return this._sortedKeys.length === 0;
    }

    raw(key) {
        return this._days.get(key) ?? null;
    }

    // Aggregate `n` consecutive days starting at `start`.
    range(start, n) {
        const apps = new Map();
        const names = {};
        const cats = zeros(4);
        const hours = zeros(24);
        const hourCats = Array.from({length: 24}, () => zeros(4));
        const hourApps = Array.from({length: 24}, () => new Map());
        const weekHeat = Array.from({length: 7}, () => zeros(24)); // summed seconds, weekday x hour
        const weekdayCount = zeros(7); // how many of each weekday are in the range
        const days = [];
        let total = 0;
        let active = 0;

        for (let i = 0; i < n; i++) {
            const date = addDays(start, i);
            const wd = weekdayIndex(date);
            weekdayCount[wd]++;
            const raw = this.raw(keyOf(date));
            const day = {date, total: 0, cats: zeros(4), hours: zeros(24), apps: new Map()};
            if (raw) {
                Object.assign(names, raw.names);
                raw.hours.forEach((bucket, h) => {
                    for (const [id, secs] of Object.entries(bucket)) {
                        if (!(secs > 0))
                            continue;
                        const c = categoryOf(id);
                        day.total += secs;
                        day.cats[c] += secs;
                        day.hours[h] += secs;
                        cats[c] += secs;
                        hours[h] += secs;
                        hourCats[h][c] += secs;
                        hourApps[h].set(id, (hourApps[h].get(id) ?? 0) + secs);
                        weekHeat[wd][h] += secs;
                        apps.set(id, (apps.get(id) ?? 0) + secs);
                        day.apps.set(id, (day.apps.get(id) ?? 0) + secs);
                    }
                });
            }
            if (day.total >= 60)
                active++;
            total += day.total;
            days.push(day);
        }

        const appList = [...apps].map(([id, secs]) => ({id, name: names[id] ?? id.replace(/\.desktop$/, ''), secs, cat: categoryOf(id)}))
            .sort((a, b) => b.secs - a.secs);
        const nameOf = id => names[id] ?? id.replace(/\.desktop$/, '');
        return {start, n, days, total, active, apps: appList, cats, hours, hourCats, hourApps, weekHeat, weekdayCount, nameOf};
    }

    // Totals for `count` months ending with the month containing `end`.
    months(end, count) {
        const out = [];
        for (let i = count - 1; i >= 0; i--) {
            const m = addMonths(end, -i);
            const agg = this.range(m, daysInMonth(m));
            out.push({date: m, total: agg.total, cats: agg.cats, active: agg.active});
        }
        return out;
    }
}
