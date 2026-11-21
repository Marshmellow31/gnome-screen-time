# Screen Time for GNOME

A macOS-style Screen Time widget for the GNOME desktop (GNOME Shell 50/51, Wayland).

- **Rectangle card:** total time today, an hourly stacked chart by category, and your top 4 apps.
- **Square card:** total time today, a daily-limit bar and your top app.
- Shows your account picture, light or dark theme, drag to reposition.

## How it tracks

One GNOME Shell extension does both the tracking and the drawing.

- Focus changes come from Mutter's `notify::focus-window` signal, so nothing polls.
- `Meta.IdleMonitor` pauses counting after an idle timeout (default 120 s). Counting also pauses while the screen is locked.
- One 30 s timer saves usage and redraws the widgets.
- Usage is stored as one small JSON file per day in `~/.local/share/screentime/` (seconds per app per hour). Files older than two years are deleted.

Only the focused app is recorded: no window titles, no keystrokes, nothing leaves your machine.

## Install

```bash
git clone <this repo> screentime
cd screentime/screentime@local
glib-compile-schemas schemas
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/screentime@local
```

Log out and back in (Wayland needs this to discover a new extension), then:

```bash
gnome-extensions enable screentime@local
```

Settings (layout, colors, daily limit, idle timeout, position) are in the Extensions app.

## The Screen Time app

`app/` is a small GTK 4 / libadwaita app (run by `gjs`, nothing to build) that reads the same files and shows the full history:

- **Today:** total vs. your daily average, an hour-by-hour strip, each app with a 7-day sparkline, and where the time went by category.
- **Week:** the week as a calendar (one column per day, one cell per hour) plus top apps and categories.
- **Month:** one ring per day (full ring = 12 hours), records and category totals.
- **Rhythm:** your average day as a 24-hour clock, a weekday × hour heat map, and facts such as your busiest and quietest hours.

Hover anything for details; click a day in Week or Month to open it. `Alt+←/→` moves between days, weeks or months, `Alt+1…4` switches pages and `Ctrl+R` refreshes (it also refreshes every minute).

Add it to the app grid and pin it to the dock:

```bash
sh app/install.sh            # or: sh app/install.sh --no-pin
```

Or run it straight from the folder with `gjs -m app/main.js`.

## Status

Early version. Chart colors come from each app's `.desktop` categories (Develop, Browse, Social, Other). Apps without a `.desktop` file are not tracked.
