#!/usr/bin/env bash
# Instala (o actualiza) la extensión para el usuario actual.
set -euo pipefail

UUID="vpn-monitor@mgomezbuceta"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
cp -r "$SRC"/metadata.json "$SRC"/extension.js "$SRC"/prefs.js "$SRC"/stylesheet.css "$SRC"/schemas "$DEST"/
glib-compile-schemas "$DEST/schemas"

SCHEMA="org.gnome.shell.extensions.vpn-monitor"
if [ -f "$SRC/vpns.json" ]; then
    CUR="$(gsettings --schemadir "$DEST/schemas" get "$SCHEMA" custom-vpns)"
    if [ "$CUR" = "'[]'" ] || [ "${1:-}" = "--reset-vpns" ]; then
        gsettings --schemadir "$DEST/schemas" set "$SCHEMA" custom-vpns "$(tr -d '\n' < "$SRC/vpns.json")"
        echo "Cargadas las VPN por comandos de vpns.json"
    fi
fi

echo "Instalada en $DEST"
if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    gnome-extensions enable "$UUID"
    echo "Activada. Para cargar cambios: en X11, Alt+F2 → r; en Wayland, cerrar sesión y volver a entrar."
else
    echo "Recarga GNOME (X11: Alt+F2 → r; Wayland: cerrar sesión y volver a entrar)"
    echo "y luego ejecuta: gnome-extensions enable $UUID"
fi
