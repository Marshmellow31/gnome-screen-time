// Per-day usage store: one small JSON file per local calendar day.
//   { hours: [ {appId: seconds, ...} x 24 ], names: {appId: displayName} }
// A whole day is a few KB, so no database is needed. Only today's file is held in memory.
import GLib from 'gi://GLib';

const RETENTION_DAYS = 90;
const pad = n => String(n).padStart(2, '0');

export function dateKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const emptyDay = () => ({hours: Array.from({length: 24}, () => ({})), names: {}});

export class Store {
    constructor(dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'screentime'])) {
        this._dir = dir;
        GLib.mkdir_with_parents(dir, 0o755);
        this._key = null;
        this._day = null;
        this._dirty = false;
        this._prune();
    }

    _path(key) {
        return GLib.build_filenamev([this._dir, `${key}.json`]);
    }

    _load(key) {
        if (this._key === key)
            return this._day;
        this.save();
        const path = this._path(key);
        let day = null;
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            try {
                const [, bytes] = GLib.file_get_contents(path);
                day = JSON.parse(new TextDecoder().decode(bytes));
                if (!day || !Array.isArray(day.hours) || day.hours.length !== 24)
                    throw new Error('unexpected format');
            } catch (e) {
                // Keep the bad file for inspection instead of silently overwriting it.
                console.warn(`screentime: ${path} is unreadable (${e.message}); moved aside, starting the day fresh`);
                GLib.rename(path, `${path}.corrupt`);
                day = null;
            }
        }
        day ??= emptyDay();
        day.hours = day.hours.map(b => (b && typeof b === 'object' && !Array.isArray(b) ? b : {}));
        if (!day.names || typeof day.names !== 'object')
            day.names = {};
        this._key = key;
        this._day = day;
        this._dirty = false;
        return day;
    }

    // Record [startMs, endMs) as time spent in `appId`, split across hour boundaries.
    addSpan(startMs, endMs, appId, name) {
        let cur = startMs;
        while (cur < endMs) {
            const d = new Date(cur);
            const hourEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
            const segEnd = Math.min(endMs, hourEnd);
            const day = this._load(dateKey(cur));
            const bucket = day.hours[d.getHours()];
            bucket[appId] = (bucket[appId] ?? 0) + (segEnd - cur) / 1000;
            day.names[appId] = name;
            this._dirty = true;
            cur = segEnd;
        }
    }

    summary(key) {
        const day = this._load(key);
        const perApp = new Map();
        let total = 0;
        for (const bucket of day.hours) {
            for (const [id, secs] of Object.entries(bucket)) {
                perApp.set(id, (perApp.get(id) ?? 0) + secs);
                total += secs;
            }
        }
        const apps = [...perApp].map(([id, secs]) => ({id, name: day.names[id] ?? id, secs}))
            .sort((a, b) => b.secs - a.secs);
        return {total, hours: day.hours, apps};
    }

    save() {
        if (!this._dirty || !this._key)
            return;
        try {
            GLib.file_set_contents(this._path(this._key), JSON.stringify(this._day));
            this._dirty = false;
        } catch (e) {
            console.warn(`screentime: could not save ${this._key}: ${e.message}`);
        }
    }

    _prune() {
        const cutoff = dateKey(Date.now() - RETENTION_DAYS * 86400 * 1000);
        try {
            const dir = GLib.Dir.open(this._dir, 0);
            let name;
            while ((name = dir.read_name()) !== null) {
                if (/^\d{4}-\d{2}-\d{2}\.json(\.corrupt)?$/.test(name) && name.slice(0, 10) < cutoff)
                    GLib.unlink(GLib.build_filenamev([this._dir, name]));
            }
            dir.close();
        } catch (_e) {
            // Pruning is best effort.
        }
    }
}
