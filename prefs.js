import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import NM from 'gi://NM';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const VPN_TYPES = ['vpn', 'wireguard'];
const TARGET_RE = /^\S+:\d{1,5}$/;
const CMD_PREFIX = 'cmd:';

const CMD_FIELDS = [
    ['name', 'Nombre'],
    ['kind', 'Tipo (texto informativo, p. ej. WireGuard o F5)'],
    ['up', 'Comando para conectar'],
    ['down', 'Comando para desconectar'],
    ['status', 'Comando de estado (código 0 = conectada)'],
];

function readJson(settings, key, fallback) {
    try {
        return JSON.parse(settings.get_string(key)) ?? fallback;
    } catch {
        return fallback;
    }
}

export default class VpnMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({title: 'Monitor de VPN', icon_name: 'network-vpn-symbolic'});
        window.add(page);

        page.add(this._generalGroup(settings));
        page.add(this._nmGroup(settings));
        page.add(this._cmdGroup(settings));
    }

    _generalGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'General'});

        const notifyRow = new Adw.SwitchRow({
            title: 'Notificaciones',
            subtitle: 'Avisar cuando una VPN se cae, se reconecta o no se puede recuperar',
        });
        settings.bind('notify-changes', notifyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(notifyRow);

        const spins = [
            ['max-retries', 0, 100, 1, 'Reintentos máximos de reconexión',
                '0 = sin límite. Entre intentos se espera 5 s, 10 s, 20 s… hasta 5 min'],
            ['poll-interval', 3, 600, 1, 'Intervalo del comando de estado (s)',
                'Solo para las VPN por comandos'],
            ['check-interval', 10, 3600, 5, 'Intervalo de comprobación de tráfico (s)',
                'Solo para las VPN con host de comprobación'],
        ];
        for (const [key, min, max, step, title, subtitle] of spins) {
            const row = Adw.SpinRow.new_with_range(min, max, step);
            row.title = title;
            row.subtitle = subtitle;
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }
        return group;
    }

    _nmGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'VPN de NetworkManager',
            description: 'El host de comprobación (opcional, host:puerto) detecta VPN que siguen ' +
                '«conectadas» pero ya no pasan tráfico.',
        });
        let conns = [];
        try {
            const client = NM.Client.new(null);
            const volatile = NM.SettingsConnectionFlags.VOLATILE;
            conns = client.get_connections()
                .filter(c => VPN_TYPES.includes(c.get_connection_type()) && !(c.get_flags() & volatile))
                .sort((a, b) => a.get_id().localeCompare(b.get_id()));
        } catch (e) {
            group.add(new Adw.ActionRow({title: 'No se pudo leer NetworkManager', subtitle: e.message}));
            return group;
        }
        if (!conns.length)
            group.add(new Adw.ActionRow({title: 'No hay VPN guardadas en NetworkManager'}));
        for (const conn of conns) {
            const row = new Adw.ExpanderRow({title: conn.get_id(), subtitle: conn.get_connection_type()});
            this._addCommonRows(settings, row, conn.get_uuid());
            group.add(row);
        }
        return group;
    }

    _cmdGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'VPN por comandos',
            description: 'Para VPN que no gestiona NetworkManager (wg-quick, f5fpc, scripts…). ' +
                'Los comandos se ejecutan con /bin/sh como tu usuario; si usan sudo, debe ser sin contraseña (sudo -n).',
        });
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Añadir VPN',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        group.set_header_suffix(addButton);

        let rows = [];
        const rebuild = () => {
            for (const row of rows)
                group.remove(row);
            rows = [];
            const list = readJson(settings, 'custom-vpns', []);
            if (!list.length) {
                const empty = new Adw.ActionRow({title: 'Ninguna todavía'});
                group.add(empty);
                rows.push(empty);
            }
            for (const vpn of list) {
                const row = this._cmdRow(settings, vpn, rebuild);
                group.add(row);
                rows.push(row);
            }
        };
        addButton.connect('clicked', () => {
            const list = readJson(settings, 'custom-vpns', []);
            list.push({id: `vpn${Date.now()}`, name: 'Nueva VPN', kind: '', up: '', down: '', status: ''});
            settings.set_string('custom-vpns', JSON.stringify(list));
            rebuild();
        });
        rebuild();
        return group;
    }

    _cmdRow(settings, vpn, rebuild) {
        const row = new Adw.ExpanderRow({title: vpn.name, subtitle: vpn.kind || 'Comandos'});
        const save = (field, value) => {
            const list = readJson(settings, 'custom-vpns', []);
            const item = list.find(v => v.id === vpn.id);
            if (!item)
                return;
            item[field] = value;
            settings.set_string('custom-vpns', JSON.stringify(list));
            if (field === 'name')
                row.title = value;
            if (field === 'kind')
                row.subtitle = value || 'Comandos';
        };
        for (const [field, title] of CMD_FIELDS) {
            const entry = new Adw.EntryRow({title, show_apply_button: true, text: vpn[field] ?? ''});
            entry.connect('apply', () => save(field, entry.text.trim()));
            row.add_row(entry);
        }
        this._addCommonRows(settings, row, CMD_PREFIX + vpn.id);

        const remove = new Adw.ActionRow({title: 'Eliminar esta VPN'});
        const removeButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'destructive-action'],
        });
        removeButton.connect('clicked', () => {
            const list = readJson(settings, 'custom-vpns', []).filter(v => v.id !== vpn.id);
            settings.set_string('custom-vpns', JSON.stringify(list));
            rebuild();
        });
        remove.add_suffix(removeButton);
        row.add_row(remove);
        return row;
    }

    _addCommonRows(settings, row, id) {
        const auto = new Adw.SwitchRow({title: 'Reconexión automática'});
        auto.active = settings.get_strv('autoreconnect-uuids').includes(id);
        auto.connect('notify::active', () => {
            const list = settings.get_strv('autoreconnect-uuids').filter(u => u !== id);
            if (auto.active)
                list.push(id);
            settings.set_strv('autoreconnect-uuids', list);
        });
        row.add_row(auto);

        const host = new Adw.EntryRow({title: 'Host de comprobación (host:puerto)', show_apply_button: true});
        host.text = readJson(settings, 'health-checks', {})[id] ?? '';
        host.connect('apply', () => {
            const value = host.text.trim();
            if (value && !TARGET_RE.test(value)) {
                host.add_css_class('error');
                return;
            }
            host.remove_css_class('error');
            const checks = readJson(settings, 'health-checks', {});
            if (value)
                checks[id] = value;
            else
                delete checks[id];
            settings.set_string('health-checks', JSON.stringify(checks));
        });
        row.add_row(host);
    }
}
