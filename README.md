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
- Usage is stored as one small JSON file per day in `~/.local/share/screentime/` (seconds per app per hour). Files older than 90 days are deleted.

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

## Status

Early version. Chart colors come from each app's `.desktop` categories (Develop, Browse, Social, Other). Apps without a `.desktop` file are not tracked.
