#!/bin/sh
# Adds "Screen Time" to the app grid and pins it to the dock. Re-run if you move this folder.
# Pass --no-pin to skip pinning.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
ID="io.github.screentime.App"
ICONS="$HOME/.local/share/icons/hicolor/scalable/apps"
APPS="$HOME/.local/share/applications"
mkdir -p "$ICONS" "$APPS"
cp "$DIR/$ID.svg" "$ICONS/"
cat > "$APPS/$ID.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Screen Time
Comment=See how you spend time on your computer
Exec=gjs -m "$DIR/main.js"
Icon=$ID
StartupWMClass=$ID
Categories=Utility;GTK;
Keywords=usage;analytics;time;apps;
StartupNotify=true
DESKTOP
gtk-update-icon-cache -q -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
update-desktop-database -q "$APPS" 2>/dev/null || true

if [ "$1" != "--no-pin" ] && command -v gsettings >/dev/null; then
    FAVS="$(gsettings get org.gnome.shell favorite-apps)"
    case "$FAVS" in
        *"'$ID.desktop'"*) ;;
        "@as []") gsettings set org.gnome.shell favorite-apps "['$ID.desktop']" ;;
        *) gsettings set org.gnome.shell favorite-apps "${FAVS%]}, '$ID.desktop']" ;;
    esac
fi
echo "Installed. Screen Time is in the app grid and pinned to the dock."
