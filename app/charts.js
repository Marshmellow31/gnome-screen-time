// Cairo-drawn charts for the Screen Time app. Each exposes `widget` (a Gtk.DrawingArea) and `set(...)`.
// Interactive charts get hover highlight, Pango-markup tooltips and an optional click callback.
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {WEEKDAYS_SHORT, hourLabel} from './data.js';

// Apple dark-mode system colors.
export const C = {
    accent: '#0A84FF',
    card: '#1C1C1E',
    fill: '#2C2C2E',
    fill2: '#38383A',
    fill3: '#48484A',
    label: '#FFFFFF',
    muted: '#98989F',
    faint: '#636366',
};

export function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

function src(cr, hex, alpha = 1) {
    const [r, g, b] = rgb(hex);
    cr.setSourceRGBA(r, g, b, alpha);
}

export function roundRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    if (r === 0) {
        cr.rectangle(x, y, w, h);
        return;
    }
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function text(area, cr, str, x, y, {size = 8, align = 'left', valign = 'top', color = C.muted, bold = false} = {}) {
    const layout = area.create_pango_layout(str);
    const fd = area.get_pango_context().get_font_description().copy();
    fd.set_size(size * Pango.SCALE);
    fd.set_weight(bold ? Pango.Weight.BOLD : Pango.Weight.NORMAL);
    layout.set_font_description(fd);
    const [, logical] = layout.get_pixel_extents();
    const tx = align === 'center' ? x - logical.width / 2 : align === 'right' ? x - logical.width : x;
    const ty = valign === 'middle' ? y - logical.height / 2 : valign === 'bottom' ? y - logical.height : y;
    src(cr, color);
    cr.moveTo(tx, ty);
    PangoCairo.show_layout(cr, layout);
}

// ---------------------------------------------------------------- base

class Chart {
    constructor(height, onActivate = null) {
        this.widget = new Gtk.DrawingArea({content_height: height, hexpand: true});
        this.hover = -1;
        this.accent = C.accent;
        this._onActivate = onActivate;
        this.widget.set_draw_func((area, cr, w, h) => {
            this.draw(area, cr, w, h);
            cr.$dispose();
        });

        const motion = new Gtk.EventControllerMotion();
        motion.connect('motion', (_c, x, y) => this._setHover(this.hit(x, y)));
        motion.connect('leave', () => this._setHover(-1));
        this.widget.add_controller(motion);

        this.widget.has_tooltip = true;
        this.widget.connect('query-tooltip', (_w, x, y, _kb, tip) => {
            const i = this.hit(x, y);
            const t = i >= 0 ? this.tooltip(i) : null;
            if (!t)
                return false;
            tip.set_markup(t);
            return true;
        });

        if (onActivate) {
            const click = new Gtk.GestureClick();
            click.connect('released', (_g, _n, x, y) => {
                const i = this.hit(x, y);
                if (i >= 0 && this.activatable(i))
                    onActivate(i);
            });
            this.widget.add_controller(click);
        }
    }

    _setHover(i) {
        if (i === this.hover)
            return;
        this.hover = i;
        if (this._onActivate)
            this.widget.set_cursor_from_name(i >= 0 && this.activatable(i) ? 'pointer' : null);
        this.widget.queue_draw();
    }

    activatable() {
        return true;
    }

    tooltip(i) {
        return this._tip?.(i) ?? null;
    }

    hit() {
        return -1;
    }
}

// ---------------------------------------------------------------- Today: 24 capsules filled by minutes used

export class HourStrip extends Chart {
    constructor() {
        super(76);
        this.mins = new Array(24).fill(0);
    }

    set(mins, tip) {
        this.mins = mins;
        this._tip = tip;
        this.widget.queue_draw();
    }

    _slot(w) {
        const gap = 5;
        return {gap, cw: (w - gap * 23) / 24};
    }

    hit(x) {
        const {gap, cw} = this._slot(this.widget.get_width());
        const i = Math.floor(x / (cw + gap));
        return i >= 0 && i < 24 ? i : -1;
    }

    draw(_area, cr, w, h) {
        const {gap, cw} = this._slot(w);
        this.mins.forEach((m, i) => {
            const x = i * (cw + gap);
            cr.save();
            roundRect(cr, x, 0, cw, h, 6);
            cr.clip();
            src(cr, i === this.hover ? C.fill2 : C.fill);
            cr.paint();
            const f = Math.min(1, m / 60);
            if (f > 0) {
                src(cr, this.accent, 0.45 + 0.55 * f);
                roundRect(cr, x, h - h * f, cw, h * f, 6);
                cr.fill();
            }
            cr.restore();
        });
    }
}

// ---------------------------------------------------------------- Week: seven day columns of 24 hour cells

export class WeekGrid extends Chart {
    constructor({onActivate = null} = {}) {
        super(24 * 16 + 40, onActivate ? i => onActivate(Math.floor(i / 24)) : null);
        this.widget.vexpand = true;
        this.days = [];
        this.selected = -1;
        this.future = 7;
    }

    // days: [{name, total, mins: [24]}]
    set(days, {selected = -1, future = 7, tip = null} = {}) {
        this.days = days;
        this.selected = selected;
        this.future = future;
        this._tip = tip ? i => tip(Math.floor(i / 24), i % 24) : null;
        this.widget.queue_draw();
    }

    _g(w, h) {
        const left = 40, head = 38, colGap = 6, rowGap = 2;
        const colW = (w - left - colGap * 6) / 7;
        const cellH = (h - head - rowGap * 23) / 24;
        return {left, head, colGap, rowGap, colW, cellH};
    }

    hit(x, y) {
        const g = this._g(this.widget.get_width(), this.widget.get_height());
        const c = Math.floor((x - g.left) / (g.colW + g.colGap));
        const r = Math.floor((y - g.head) / (g.cellH + g.rowGap));
        if (c < 0 || c > 6 || r < 0 || r > 23 || x < g.left)
            return -1;
        return c * 24 + r;
    }

    activatable(i) {
        return Math.floor(i / 24) < this.future;
    }

    draw(area, cr, w, h) {
        const g = this._g(w, h);
        ['12 AM', '6 AM', '12 PM', '6 PM'].forEach((t, k) =>
            text(area, cr, t, 0, g.head + k * 6 * (g.cellH + g.rowGap), {size: 7}));
        const hoverCol = this.hover >= 0 ? Math.floor(this.hover / 24) : -1;
        this.days.forEach((d, c) => {
            const x = g.left + c * (g.colW + g.colGap);
            if (c === hoverCol && c < this.future) {
                src(cr, C.fill, 0.6);
                roundRect(cr, x - 3, 0, g.colW + 6, h, 8);
                cr.fill();
            }
            text(area, cr, d.name, x + g.colW / 2, 2, {size: 7.5, align: 'center', bold: true, color: c === this.selected ? this.accent : C.muted});
            text(area, cr, d.total, x + g.colW / 2, 17, {size: 8.5, align: 'center', bold: true, color: c < this.future ? C.label : C.faint});
            d.mins.forEach((m, r) => {
                const y = g.head + r * (g.cellH + g.rowGap);
                if (m > 0)
                    src(cr, this.accent, 0.25 + 0.75 * Math.min(1, m / 60));
                else
                    src(cr, C.fill);
                roundRect(cr, x, y, g.colW, g.cellH, 4);
                cr.fill();
                if (this.hover === c * 24 + r) {
                    src(cr, C.label, 0.9);
                    cr.setLineWidth(1.5);
                    roundRect(cr, x + 0.75, y + 0.75, g.colW - 1.5, g.cellH - 1.5, 4);
                    cr.stroke();
                }
            });
        });
    }
}

// ---------------------------------------------------------------- Month: one ring per day

export class RingCalendar extends Chart {
    constructor({onActivate = null} = {}) {
        super(300, onActivate);
        this.values = [];
        this.offset = 0;
        this.today = -1;
        this.future = 99;
        this.full = 12 * 3600;
        this.widget.vexpand = true;
    }

    set(offset, values, {today = -1, future = 99, tip = null, label = null} = {}) {
        this.offset = offset;
        this.values = values;
        this.today = today;
        this.future = future;
        this._tip = tip;
        this._label = label;
        this.widget.queue_draw();
    }

    _g(w, h) {
        const head = 20, gap = 4;
        const rows = Math.max(1, Math.ceil((this.offset + this.values.length) / 7));
        const cw = (w - gap * 6) / 7;
        const ch = (h - head - gap * (rows - 1)) / rows;
        const r = Math.max(10, Math.min(24, cw / 2 - 6, (ch - 16) / 2 - 2));
        return {head, gap, rows, cw, ch, r};
    }

    hit(x, y) {
        const g = this._g(this.widget.get_width(), this.widget.get_height());
        const c = Math.floor(x / (g.cw + g.gap));
        const r = Math.floor((y - g.head) / (g.ch + g.gap));
        if (y < g.head || c < 0 || c > 6 || r < 0)
            return -1;
        const d = r * 7 + c - this.offset;
        return d >= 0 && d < this.values.length ? d : -1;
    }

    activatable(i) {
        return i < this.future;
    }

    draw(area, cr, w, h) {
        const g = this._g(w, h);
        WEEKDAYS_SHORT.forEach((d, c) => text(area, cr, d, c * (g.cw + g.gap) + g.cw / 2, 0, {size: 7.5, align: 'center', bold: true}));
        this.values.forEach((v, d) => {
            const pos = d + this.offset;
            const x = (pos % 7) * (g.cw + g.gap);
            const y = g.head + Math.floor(pos / 7) * (g.ch + g.gap);
            const future = d >= this.future;
            if (this.hover === d && !future) {
                src(cr, C.fill);
                roundRect(cr, x, y, g.cw, g.ch, 10);
                cr.fill();
            }
            const cx = x + g.cw / 2;
            const cy = y + (g.ch - 14) / 2;
            const lw = Math.max(4, g.r * 0.22);
            cr.setLineWidth(lw);
            cr.setLineCap(1); // ROUND
            if (!future) {
                cr.newPath();
                src(cr, v > 0 ? C.fill2 : C.fill);
                cr.arc(cx, cy, g.r - lw / 2, 0, 2 * Math.PI);
                cr.stroke();
            }
            if (v > 0) {
                const f = Math.min(1, v / this.full);
                cr.newPath();
                src(cr, this.accent);
                cr.arc(cx, cy, g.r - lw / 2, -Math.PI / 2, -Math.PI / 2 + f * 2 * Math.PI);
                cr.stroke();
            }
            if (d === this.today) {
                cr.newPath();
                src(cr, C.label);
                cr.setLineWidth(1.5);
                cr.arc(cx, cy, g.r + 3, 0, 2 * Math.PI);
                cr.stroke();
            }
            text(area, cr, String(d + 1), cx, cy, {size: 8.5, align: 'center', valign: 'middle', bold: true, color: future ? C.faint : C.label});
            const lbl = this._label?.(d);
            if (lbl)
                text(area, cr, lbl, cx, cy + g.r + 3, {size: 7, align: 'center', color: v > 0 ? '#D1D1D6' : C.faint});
        });
    }
}

// ---------------------------------------------------------------- Rhythm: 24-hour clock of the average day

export class RhythmClock extends Chart {
    constructor(size = 176) {
        super(size + 36);
        this.size = size;
        this.values = new Array(24).fill(0);
        this.center = '';
        this.caption = '';
        this.widget.hexpand = false;
        this.widget.content_width = size + 76;
        this.widget.halign = Gtk.Align.CENTER;
    }

    set(values, center, caption, tip) {
        this.values = values;
        this.center = center;
        this.caption = caption;
        this._tip = tip;
        this.widget.queue_draw();
    }

    _geo(w, h) {
        return {cx: w / 2, cy: h / 2, R: this.size / 2, r: this.size / 2 - 30};
    }

    hit(x, y) {
        const {cx, cy, R, r} = this._geo(this.widget.get_width(), this.widget.get_height());
        const dx = x - cx, dy = y - cy;
        const d = Math.hypot(dx, dy);
        if (d < r || d > R)
            return -1;
        let a = Math.atan2(dx, -dy); // 0 at top, clockwise
        if (a < 0)
            a += 2 * Math.PI;
        return Math.floor(a / (2 * Math.PI) * 24) % 24;
    }

    draw(area, cr, w, h) {
        const {cx, cy, R, r} = this._geo(w, h);
        const max = Math.max(...this.values, 1);
        const step = (2 * Math.PI) / 24;
        this.values.forEach((v, i) => {
            const a0 = -Math.PI / 2 + i * step + 0.03;
            const a1 = a0 + step - 0.06;
            cr.newPath();
            cr.arc(cx, cy, R, a0, a1);
            cr.arcNegative(cx, cy, r, a1, a0);
            cr.closePath();
            if (v > 0)
                src(cr, this.accent, Math.min(1, 0.2 + 0.8 * v / max + (i === this.hover ? 0.15 : 0)));
            else
                src(cr, i === this.hover ? C.fill2 : C.fill);
            cr.fill();
        });
        text(area, cr, this.center, cx, cy + 1, {size: 14, align: 'center', valign: 'bottom', bold: true, color: C.label});
        text(area, cr, this.caption, cx, cy + 2, {size: 7.5, align: 'center'});
        text(area, cr, '12 AM', cx, cy - R - 3, {size: 7, align: 'center', valign: 'bottom'});
        text(area, cr, '12 PM', cx, cy + R + 3, {size: 7, align: 'center'});
        text(area, cr, '6 AM', cx + R + 6, cy, {size: 7, valign: 'middle'});
        text(area, cr, '6 PM', cx - R - 6, cy, {size: 7, align: 'right', valign: 'middle'});
    }
}

// ---------------------------------------------------------------- Rhythm: weekday x hour heat map

export class Heatmap extends Chart {
    constructor() {
        super(7 * 26 + 18);
        this.widget.vexpand = true;
        this.matrix = [];
        this.labels = [];
    }

    set(matrix, labels, tip) {
        this.matrix = matrix;
        this.labels = labels;
        this._tip = tip ? i => tip(Math.floor(i / 24), i % 24) : null;
        this.widget.content_height = matrix.length * 26 + 18;
        this.widget.queue_draw();
    }

    // Rows stretch to fill the card, up to 40 px tall.
    _g(w, h) {
        const left = 38, gap = 4, rows = Math.max(1, this.matrix.length);
        const cellH = Math.max(18, Math.min(40, (h - 18 - gap * (rows - 1)) / rows));
        return {left, gap, cellH, cw: (w - left - gap * 23) / 24};
    }

    hit(x, y) {
        const g = this._g(this.widget.get_width(), this.widget.get_height());
        const c = Math.floor((x - g.left) / (g.cw + g.gap));
        const r = Math.floor(y / (g.cellH + g.gap));
        if (x < g.left || c < 0 || c > 23 || r < 0 || r >= this.matrix.length)
            return -1;
        return r * 24 + c;
    }

    draw(area, cr, w, h) {
        const g = this._g(w, h);
        const max = Math.max(1, ...this.matrix.flat());
        this.matrix.forEach((row, r) => {
            const y = r * (g.cellH + g.gap);
            text(area, cr, this.labels[r], 0, y + g.cellH / 2, {size: 7.5, valign: 'middle', bold: true});
            row.forEach((v, c) => {
                const x = g.left + c * (g.cw + g.gap);
                if (v > 0)
                    src(cr, this.accent, Math.min(1, 0.25 + 0.75 * v / max));
                else
                    src(cr, C.fill);
                roundRect(cr, x, y, g.cw, g.cellH, 5);
                cr.fill();
                if (this.hover === r * 24 + c) {
                    src(cr, C.label, 0.9);
                    cr.setLineWidth(1.5);
                    roundRect(cr, x + 0.75, y + 0.75, g.cw - 1.5, g.cellH - 1.5, 5);
                    cr.stroke();
                }
            });
        });
        const by = this.matrix.length * (g.cellH + g.gap) + 2;
        [0, 6, 12, 18].forEach(hh => text(area, cr, hourLabel(hh), g.left + hh * (g.cw + g.gap), by, {size: 7}));
    }
}

// ---------------------------------------------------------------- small static pieces

function staticArea(width, height, draw) {
    const area = new Gtk.DrawingArea({content_height: height, hexpand: width < 0});
    if (width > 0)
        area.content_width = width;
    area.set_draw_func((a, cr, w, h) => {
        draw(a, cr, w, h);
        cr.$dispose();
    });
    return area;
}

// Proportional split bar. parts: [{value, color}]
export function segmentBar(parts, height = 10) {
    return staticArea(-1, height, (_a, cr, w, h) => {
        const total = parts.reduce((x, p) => x + p.value, 0);
        if (total <= 0) {
            src(cr, C.fill);
            roundRect(cr, 0, 0, w, h, h / 2);
            cr.fill();
            return;
        }
        const shown = parts.filter(p => p.value > 0);
        const gap = 2;
        const avail = w - gap * (shown.length - 1);
        roundRect(cr, 0, 0, w, h, h / 2);
        cr.clip();
        let x = 0;
        shown.forEach(p => {
            const ww = Math.max(3, (p.value / total) * avail);
            src(cr, p.color);
            cr.rectangle(x, 0, ww, h);
            cr.fill();
            x += ww + gap;
        });
    });
}

// Thin progress bar.
export function meter(fraction, color, height = 5) {
    const area = staticArea(-1, height, (_a, cr, w, h) => {
        src(cr, C.fill);
        roundRect(cr, 0, 0, w, h, h / 2);
        cr.fill();
        if (fraction > 0) {
            src(cr, color);
            roundRect(cr, 0, 0, Math.max(h, w * Math.min(1, fraction)), h, h / 2);
            cr.fill();
        }
    });
    area.valign = Gtk.Align.CENTER;
    return area;
}

// Mini bar chart of recent days; the last bar is highlighted.
export function sparkline(values, color, width = 54, height = 24) {
    const area = staticArea(width, height, (_a, cr, w, h) => {
        const max = Math.max(...values, 1);
        const gap = 2;
        const bw = (w - gap * (values.length - 1)) / values.length;
        values.forEach((v, i) => {
            const bh = Math.max(3, (v / max) * h);
            src(cr, i === values.length - 1 ? color : C.fill3);
            roundRect(cr, i * (bw + gap), h - bh, bw, bh, 2);
            cr.fill();
        });
    });
    area.valign = Gtk.Align.CENTER;
    return area;
}
