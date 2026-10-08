// Monitor de VPN: lista las VPN (de NetworkManager o lanzadas por comandos),
// muestra su estado y reconecta automáticamente las elegidas cuando se caen.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import NM from 'gi://NM';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const VPN_TYPES = ['vpn', 'wireguard'];
const HEALTH_FAILS_TO_DROP = 2;
const MAX_BACKOFF = 300;
const NO_NETWORK_WAIT = 10;
const TICK = 2;
const CMD_CONNECT_TIMEOUT = 60;
const CMD_DISCONNECT_TIMEOUT = 30;
const CMD_STATUS_TIMEOUT = 15;
const CMD_PREFIX = 'cmd:';

const AS = NM.ActiveConnectionState;
const R = NM.ActiveConnectionStateReason;

const REASONS = {
    [R.DEVICE_DISCONNECTED]: 'se cayó la red subyacente',
    [R.SERVICE_STOPPED]: 'el servicio VPN se detuvo',
    [R.IP_CONFIG_INVALID]: 'configuración IP no válida',
    [R.CONNECT_TIMEOUT]: 'tiempo de conexión agotado',
    [R.SERVICE_START_TIMEOUT]: 'el servicio VPN tardó demasiado en arrancar',
    [R.SERVICE_START_FAILED]: 'no arrancó el servicio VPN',
    [R.NO_SECRETS]: 'faltan credenciales',
    [R.LOGIN_FAILED]: 'fallo de autenticación',
    [R.CONNECTION_REMOVED]: 'la conexión se eliminó',
    [R.DEPENDENCY_FAILED]: 'falló una dependencia',
    [R.DEVICE_REMOVED]: 'se quitó el dispositivo',
};

const SERVICES = {
    openvpn: 'OpenVPN',
    vpnc: 'Cisco (vpnc)',
    openconnect: 'OpenConnect',
    l2tp: 'L2TP',
    pptp: 'PPTP',
    fortisslvpn: 'Fortinet SSL',
    strongswan: 'IPsec (strongSwan)',
    libreswan: 'IPsec (Libreswan)',
    sstp: 'SSTP',
};

function reasonText(reason) {
    return REASONS[reason] ?? 'motivo desconocido';
}

function vpnKind(conn) {
    if (conn.get_connection_type() === 'wireguard')
        return 'WireGuard';
    const service = conn.get_setting_vpn()?.get_service_type() ?? '';
    const last = service.split('.').pop();
    return SERVICES[last] ?? (last || 'VPN');
}

// Los perfiles volátiles son los que NetworkManager crea solo mientras existe
// una interfaz levantada por fuera (p. ej. wg-quick): no se pueden reactivar.
function isVolatile(conn) {
    return Boolean((conn?.get_flags?.() ?? 0) & NM.SettingsConnectionFlags.VOLATILE);
}

function isNmVpn(conn) {
    return VPN_TYPES.includes(conn.get_connection_type()) && !isVolatile(conn);
}

function now() {
    return GLib.get_monotonic_time() / 1e6;
}

function lastLine(text) {
    return (text ?? '').trim().split('\n').pop().slice(0, 200);
}

function runCommand(cmd, cancellable, timeout = 0) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(['/bin/sh', '-c', cmd],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (e) {
            resolve({ok: false, out: e.message});
            return;
        }
        let timer = 0;
        if (timeout) {
            timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeout, () => {
                timer = 0;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
        }
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            if (timer)
                GLib.source_remove(timer);
            try {
                const [, out] = p.communicate_utf8_finish(res);
                resolve({ok: p.get_successful(), out});
            } catch (e) {
                resolve({ok: false, out: e.message,
                    cancelled: e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)});
            }
        });
    });
}

class VpnMonitor {
    constructor(settings, onChanged, notify) {
        this._settings = settings;
        this._onChanged = onChanged;
        this._notify = notify;
        this._client = null;
        this._error = null;
        this._destroyed = false;
        this._cancellable = new Gio.Cancellable();
        this._clientSignals = [];
        this._acSignals = new Map();
        this._wasUp = new WeakSet();
        this._handled = new WeakSet();
        this._cmd = new Map();
        this._manualOff = new Set();
        this._refreshing = new Set();
        this._lost = new Set();
        this._unhealthy = new Set();
        this._retries = new Map();
        this._retryTimers = new Map();
        this._healthFails = new Map();
        this._healthTimer = 0;

        this._settingsId = this._settings.connect('changed', (_s, key) => {
            if (key === 'check-interval')
                this._restartHealthTimer();
            if (key === 'autoreconnect-uuids') {
                for (const id of [...this._retryTimers.keys()]) {
                    if (!this.isAuto(id))
                        this._stopRetrying(id);
                }
            }
            this._onChanged();
        });

        this._tickTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._restartHealthTimer();
        this._tick();

        NM.Client.new_async(this._cancellable, (_o, res) => {
            try {
                this._client = NM.Client.new_finish(res);
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                this._error = `No se pudo conectar con NetworkManager: ${e.message}`;
                this._onChanged();
                return;
            }
            this._setupClient();
        });
    }

    get error() {
        return this._error;
    }

    get ready() {
        return this._client !== null || this._error !== null;
    }

    // --- NetworkManager ---

    _setupClient() {
        const c = this._client;
        this._clientSignals = [
            c.connect('connection-added', () => this._onChanged()),
            c.connect('connection-removed', (_c, conn) => {
                this._forget(conn.get_uuid());
                this._onChanged();
            }),
            c.connect('active-connection-added', (_c, ac) => {
                this._attach(ac);
                this._onChanged();
            }),
            c.connect('active-connection-removed', (_c, ac) => {
                this._detach(ac);
                this._onChanged();
            }),
        ];
        for (const ac of c.get_active_connections())
            this._attach(ac);
        this._onChanged();
    }

    _attach(ac) {
        if (!VPN_TYPES.includes(ac.get_connection_type()) || isVolatile(ac.get_connection()) ||
            this._acSignals.has(ac))
            return;
        if (ac.get_state() === AS.ACTIVATED)
            this._wasUp.add(ac);
        const id = ac.connect('state-changed', (_ac, state, reason) => {
            if (state === AS.ACTIVATED) {
                this._wasUp.add(ac);
                this._handleUp(ac.get_uuid());
            } else if (state === AS.DEACTIVATED && !this._handled.has(ac)) {
                this._nmDown(ac, reason);
            }
            this._onChanged();
        });
        this._acSignals.set(ac, id);
    }

    _detach(ac) {
        const id = this._acSignals.get(ac);
        if (id === undefined)
            return;
        ac.disconnect(id);
        this._acSignals.delete(ac);
        // Puede desaparecer sin que llegue el estado DEACTIVATED.
        if (!this._handled.has(ac))
            this._nmDown(ac, ac.get_state_reason());
    }

    _nmDown(ac, reason) {
        this._handled.add(ac);
        const voluntary = reason === R.USER_DISCONNECTED || reason === R.CONNECTION_REMOVED;
        this._handleDown(ac.get_uuid(), this._wasUp.has(ac), reasonText(reason), voluntary);
    }

    _findActive(uuid) {
        return this._client?.get_active_connections().find(ac => ac.get_uuid() === uuid) ?? null;
    }

    // --- VPN por comandos ---

    _customs() {
        try {
            const list = JSON.parse(this._settings.get_string('custom-vpns'));
            return Array.isArray(list)
                ? list.filter(v => v?.id && v.name && v.up && v.down && v.status)
                : [];
        } catch {
            return [];
        }
    }

    _custom(id) {
        return this._customs().find(v => CMD_PREFIX + v.id === id) ?? null;
    }

    _cmdState(id) {
        let st = this._cmd.get(id);
        if (!st) {
            st = {up: null, busy: null, deadline: 0, lastPoll: -Infinity, polling: false, out: ''};
            this._cmd.set(id, st);
        }
        return st;
    }

    _tick() {
        const t = now();
        const interval = this._settings.get_int('poll-interval');
        for (const v of this._customs()) {
            const id = CMD_PREFIX + v.id;
            const st = this._cmdState(id);
            if (st.polling)
                continue;
            if (st.busy && t > st.deadline)
                this._cmdBusyTimeout(id, v, st);
            if (st.busy || t - st.lastPoll >= interval)
                this._poll(id, v, st);
        }
    }

    async _poll(id, v, st) {
        st.polling = true;
        st.lastPoll = now();
        const r = await runCommand(v.status, this._cancellable, CMD_STATUS_TIMEOUT);
        st.polling = false;
        if (r.cancelled || this._destroyed)
            return;
        const up = r.ok;
        if (st.up === null) {
            st.up = up;
        } else if (up && !st.up) {
            st.up = true;
            st.busy = null;
            this._handleUp(id);
        } else if (!up && st.up) {
            st.up = false;
            st.busy = null;
            this._handleDown(id, true, 'el comando de estado la da por desconectada', false);
        } else if (!up && st.busy === 'disconnecting') {
            // Se bajó mientras aún estaba conectando.
            st.busy = null;
            this._handleDown(id, false, '', true);
        }
        this._onChanged();
    }

    _cmdBusyTimeout(id, v, st) {
        const busy = st.busy;
        st.busy = null;
        if (busy === 'connecting') {
            const detail = st.out ? `: ${st.out}` : '';
            this._handleDown(id, false, `no conectó en ${CMD_CONNECT_TIMEOUT} s${detail}`, false);
        } else {
            this._refreshing.delete(id);
            this._manualOff.delete(id);
            this._notify('No se pudo desconectar la VPN', `${v.name}: sigue conectada.`);
        }
        this._onChanged();
    }

    async _cmdRun(id, v, busy, cmd, timeout) {
        const st = this._cmdState(id);
        st.busy = busy;
        st.deadline = now() + timeout;
        st.out = '';
        const r = await runCommand(cmd, this._cancellable);
        if (!r.cancelled && !this._destroyed)
            st.out = lastLine(r.out);
    }

    // --- Lógica común de caídas y reconexión ---

    _handleUp(id) {
        this._manualOff.delete(id);
        this._unhealthy.delete(id);
        this._healthFails.delete(id);
        const recovering = this._lost.delete(id);
        this._stopRetrying(id);
        if (recovering)
            this._notify('VPN reconectada', `${this._name(id)} vuelve a estar conectada.`);
    }

    _handleDown(id, wasUp, reason, voluntary) {
        const name = this._name(id);
        if (this._refreshing.delete(id)) {
            this._activate(id);
            return;
        }
        if (this._manualOff.delete(id) || voluntary) {
            // Desconexión voluntaria (desde aquí, el menú de GNOME o nmcli).
            this._lost.delete(id);
            this._unhealthy.delete(id);
            this._stopRetrying(id);
            return;
        }

        const auto = this.isAuto(id);
        if (wasUp && !this._lost.has(id)) {
            this._lost.add(id);
            this._notify('VPN caída',
                `${name} se ha desconectado (${reason}).${auto ? ' Intentando reconectar…' : ''}`,
                !auto);
            if (auto)
                this._retries.set(id, 0);
        } else if (!this._retries.has(id)) {
            this._notify('No se pudo conectar la VPN', `${name}: ${reason}.`);
        }

        if (auto && this._retries.has(id))
            this._scheduleRetry(id);
    }

    _scheduleRetry(id, delay = null) {
        if (this._retryTimers.has(id))
            return;
        const n = this._retries.get(id) ?? 0;
        const max = this._settings.get_int('max-retries');
        if (max > 0 && n >= max) {
            this._stopRetrying(id);
            this._notify('VPN sin recuperar',
                `${this._name(id)}: no se pudo reconectar tras ${n} intentos. Revísala a mano.`,
                true);
            this._onChanged();
            return;
        }
        const wait = delay ?? Math.min(5 * 2 ** n, MAX_BACKOFF);
        const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, wait, () => {
            this._retryTimers.delete(id);
            if (this._client && !this._client.get_primary_connection()) {
                // Sin red: esperamos sin gastar intentos.
                this._scheduleRetry(id, NO_NETWORK_WAIT);
            } else {
                this._retries.set(id, n + 1);
                this._activate(id);
            }
            this._onChanged();
            return GLib.SOURCE_REMOVE;
        });
        this._retryTimers.set(id, timer);
    }

    _stopRetrying(id) {
        const timer = this._retryTimers.get(id);
        if (timer)
            GLib.source_remove(timer);
        this._retryTimers.delete(id);
        this._retries.delete(id);
    }

    _forget(id) {
        this._forgetProblems(id);
        this._manualOff.delete(id);
        this._refreshing.delete(id);
    }

    _forgetProblems(id) {
        this._stopRetrying(id);
        this._lost.delete(id);
        this._unhealthy.delete(id);
        this._healthFails.delete(id);
    }

    _name(id) {
        if (id.startsWith(CMD_PREFIX))
            return this._custom(id)?.name ?? id;
        return this._client?.get_connection_by_uuid(id)?.get_id() ?? id;
    }

    _isActive(id) {
        if (id.startsWith(CMD_PREFIX)) {
            const st = this._cmdState(id);
            return st.busy === 'connecting' || (st.up === true && st.busy !== 'disconnecting');
        }
        const ac = this._findActive(id);
        return Boolean(ac) && ac.get_state() !== AS.DEACTIVATED;
    }

    _activate(id) {
        if (id.startsWith(CMD_PREFIX)) {
            const v = this._custom(id);
            if (!v)
                return;
            // En los reintentos se baja antes por si quedó a medias (p. ej. la
            // interfaz de wg-quick sigue creada aunque el túnel no responda).
            const cmd = this._retries.has(id) ? `(${v.down}) >/dev/null 2>&1; ${v.up}` : v.up;
            this._cmdRun(id, v, 'connecting', cmd, CMD_CONNECT_TIMEOUT);
            return;
        }
        const conn = this._client?.get_connection_by_uuid(id);
        if (!conn)
            return;
        this._client.activate_connection_async(conn, null, null, this._cancellable, (c, res) => {
            try {
                c.activate_connection_finish(res);
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                if (this._retries.has(id))
                    this._scheduleRetry(id);
                else
                    this._notify('No se pudo conectar la VPN', `${conn.get_id()}: ${e.message}`);
                this._onChanged();
            }
        });
    }

    _deactivate(id) {
        if (id.startsWith(CMD_PREFIX)) {
            const v = this._custom(id);
            if (v)
                this._cmdRun(id, v, 'disconnecting', v.down, CMD_DISCONNECT_TIMEOUT);
            return;
        }
        const ac = this._findActive(id);
        if (!ac)
            return;
        this._client.deactivate_connection_async(ac, this._cancellable, (c, res) => {
            try {
                c.deactivate_connection_finish(res);
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                this._refreshing.delete(id);
                this._notify('No se pudo desconectar la VPN', `${ac.get_id()}: ${e.message}`);
                this._onChanged();
            }
        });
    }

    // --- Acciones del menú ---

    toggle(id) {
        if (this._isActive(id)) {
            this._manualOff.add(id);
            this._forgetProblems(id);
            this._deactivate(id);
        } else {
            this._manualOff.delete(id);
            this._activate(id);
        }
        this._onChanged();
    }

    refresh(id) {
        const pending = this._retryTimers.get(id);
        if (pending) {
            GLib.source_remove(pending);
            this._retryTimers.delete(id);
        }
        this._manualOff.delete(id);
        if (this._isActive(id)) {
            this._refreshing.add(id);
            this._deactivate(id);
        } else {
            this._activate(id);
        }
        this._onChanged();
    }

    isAuto(id) {
        return this._settings.get_strv('autoreconnect-uuids').includes(id);
    }

    setAuto(id, enabled) {
        const list = this._settings.get_strv('autoreconnect-uuids').filter(u => u !== id);
        if (enabled)
            list.push(id);
        this._settings.set_strv('autoreconnect-uuids', list);
    }

    // --- Comprobación de tráfico ---

    _healthChecks() {
        try {
            return JSON.parse(this._settings.get_string('health-checks')) ?? {};
        } catch {
            return {};
        }
    }

    _restartHealthTimer() {
        if (this._healthTimer)
            GLib.source_remove(this._healthTimer);
        this._healthTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('check-interval'), () => {
                this._runHealthChecks();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _isUpAndIdle(id) {
        if (this._refreshing.has(id))
            return false;
        if (id.startsWith(CMD_PREFIX)) {
            const st = this._cmdState(id);
            return st.up === true && !st.busy;
        }
        return this._findActive(id)?.get_state() === AS.ACTIVATED;
    }

    _runHealthChecks() {
        for (const [id, target] of Object.entries(this._healthChecks())) {
            if (!target || !this._isUpAndIdle(id))
                continue;
            const sock = new Gio.SocketClient({timeout: 5});
            sock.connect_to_host_async(target, 0, this._cancellable, (s, res) => {
                let ok = true;
                try {
                    s.connect_to_host_finish(res).close(null);
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    ok = false;
                }
                this._onHealthResult(id, target, ok);
            });
        }
    }

    _onHealthResult(id, target, ok) {
        if (ok) {
            this._healthFails.delete(id);
            if (this._unhealthy.delete(id))
                this._onChanged();
            return;
        }
        const fails = (this._healthFails.get(id) ?? 0) + 1;
        this._healthFails.set(id, fails);
        if (fails < HEALTH_FAILS_TO_DROP || this._unhealthy.has(id))
            return;

        this._unhealthy.add(id);
        const auto = this.isAuto(id);
        this._notify('VPN sin tráfico',
            `${this._name(id)} sigue conectada pero no llega a ${target}.${auto ? ' Reconectando…' : ''}`,
            !auto);
        if (auto) {
            this._lost.add(id);
            this._retries.set(id, 0);
            this.refresh(id);
        }
        this._onChanged();
    }

    // --- Estado para la interfaz ---

    getVpns() {
        const nm = (this._client?.get_connections() ?? [])
            .filter(isNmVpn)
            .map(conn => {
                const uuid = conn.get_uuid();
                return {id: uuid, name: conn.get_id(), kind: vpnKind(conn),
                    ...this._nmStatus(uuid)};
            });
        const cmd = this._customs().map(v => {
            const id = CMD_PREFIX + v.id;
            return {id, name: v.name, kind: v.kind || 'Comandos', ...this._cmdStatus(id)};
        });
        return [...nm, ...cmd]
            .map(v => ({...v, auto: this.isAuto(v.id)}))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    _nmStatus(id) {
        const state = this._findActive(id)?.get_state() ?? AS.DEACTIVATED;
        if (state === AS.ACTIVATED)
            return this._upStatus(id);
        if (state === AS.ACTIVATING)
            return {active: true, level: 'busy', text: 'Conectando…'};
        if (state === AS.DEACTIVATING)
            return {active: false, level: 'busy', text: 'Desconectando…'};
        return this._downStatus(id);
    }

    _cmdStatus(id) {
        const st = this._cmdState(id);
        if (st.busy === 'connecting')
            return {active: true, level: 'busy', text: 'Conectando…'};
        if (st.busy === 'disconnecting')
            return {active: false, level: 'busy', text: 'Desconectando…'};
        if (st.up === null)
            return {active: false, level: 'off', text: 'Comprobando…'};
        return st.up ? this._upStatus(id) : this._downStatus(id);
    }

    _upStatus(id) {
        if (this._unhealthy.has(id))
            return {active: true, level: 'bad', text: 'Sin tráfico'};
        return {active: true, level: 'ok', text: 'Conectada'};
    }

    _downStatus(id) {
        if (this._retries.has(id))
            return {active: false, level: 'bad', text: `Caída · reintento ${this._retries.get(id) + 1}`};
        if (this._lost.has(id))
            return {active: false, level: 'bad', text: 'Caída'};
        return {active: false, level: 'off', text: 'Desconectada'};
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        this._settings.disconnect(this._settingsId);
        for (const timer of [this._healthTimer, this._tickTimer, ...this._retryTimers.values()]) {
            if (timer)
                GLib.source_remove(timer);
        }
        this._healthTimer = 0;
        this._tickTimer = 0;
        this._retryTimers.clear();
        for (const [ac, id] of this._acSignals)
            ac.disconnect(id);
        this._acSignals.clear();
        for (const id of this._clientSignals)
            this._client.disconnect(id);
        this._clientSignals = [];
        this._client = null;
    }
}

const VpnItem = GObject.registerClass(
class VpnItem extends PopupMenu.PopupBaseMenuItem {
    _init(monitor, id) {
        super._init({style_class: 'vpn-monitor-item'});
        this._monitor = monitor;
        this._id = id;

        this._icon = new St.Icon({
            icon_name: 'network-vpn-symbolic',
            style_class: 'popup-menu-icon',
        });
        this.add_child(this._icon);

        this._label = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._label);
        this.label_actor = this._label;

        this._autoBtn = this._button('emblem-synchronizing-symbolic', 'Reconexión automática',
            () => monitor.setAuto(id, !this._auto));
        this._autoBtn.toggle_mode = true;
        this._refreshBtn = this._button('view-refresh-symbolic', 'Refrescar conexión',
            () => monitor.refresh(id));

        this._switch = new PopupMenu.Switch(false);
        this._switch.y_align = Clutter.ActorAlign.CENTER;
        this.add_child(this._switch);

        this.connect('activate', () => monitor.toggle(id));
    }

    _button(iconName, accessibleName, onClick) {
        const btn = new St.Button({
            style_class: 'vpn-monitor-button',
            can_focus: true,
            accessible_name: accessibleName,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        btn.connect('clicked', onClick);
        this.add_child(btn);
        return btn;
    }

    update(vpn) {
        this._auto = vpn.auto;
        this._autoBtn.checked = vpn.auto;
        this._switch.state = vpn.active;
        const sub = `${vpn.kind} · ${vpn.text}${vpn.auto ? ' · reconexión automática' : ''}`;
        this._label.clutter_text.set_markup(
            `${GLib.markup_escape_text(vpn.name, -1)}\n<small>${GLib.markup_escape_text(sub, -1)}</small>`);
        for (const level of ['ok', 'busy', 'bad', 'off'])
            this._icon.remove_style_class_name(`vpn-monitor-${level}`);
        this._icon.add_style_class_name(`vpn-monitor-${vpn.level}`);
    }
});

const VpnIndicator = GObject.registerClass(
class VpnIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Monitor de VPN');
        this._extension = extension;
        this._items = new Map();
        this._uuids = '';

        this._icon = new St.Icon({
            icon_name: 'network-vpn-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Preferencias', () => extension.openPreferences());
    }

    setMonitor(monitor) {
        this._monitor = monitor;
    }

    sync() {
        if (!this._monitor)
            return;
        const vpns = this._monitor.getVpns();
        const uuids = `${this._monitor.ready}:${this._monitor.error}:${vpns.map(v => v.id).join(',')}`;

        if (uuids !== this._uuids) {
            this._uuids = uuids;
            this._section.removeAll();
            this._items.clear();
            let message = this._monitor.error;
            if (!message && !this._monitor.ready)
                message = 'Cargando…';
            else if (!message && !vpns.length)
                message = 'No hay VPN configuradas';
            if (message) {
                const item = new PopupMenu.PopupMenuItem(message, {reactive: false});
                this._section.addMenuItem(item);
            }
            for (const vpn of vpns) {
                const item = new VpnItem(this._monitor, vpn.id);
                this._items.set(vpn.id, item);
                this._section.addMenuItem(item);
            }
        }
        for (const vpn of vpns)
            this._items.get(vpn.id)?.update(vpn);

        let level = 'off';
        if (vpns.some(v => v.level === 'bad'))
            level = 'bad';
        else if (vpns.some(v => v.level === 'busy'))
            level = 'busy';
        else if (vpns.some(v => v.level === 'ok'))
            level = 'ok';
        for (const l of ['ok', 'busy', 'bad', 'off'])
            this._icon.remove_style_class_name(`vpn-monitor-${l}`);
        this._icon.add_style_class_name(`vpn-monitor-${level}`);
    }
});

export default class VpnMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new VpnIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._monitor = new VpnMonitor(this._settings,
            () => this._indicator?.sync(),
            (title, body, urgent) => this._notify(title, body, urgent));
        this._indicator.setMonitor(this._monitor);
        this._indicator.sync();
    }

    disable() {
        this._monitor?.destroy();
        this._monitor = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._source?.destroy();
        this._source = null;
        this._settings = null;
    }

    _notify(title, body, urgent = false) {
        if (!this._settings?.get_boolean('notify-changes'))
            return;
        try {
            if (!this._source) {
                this._source = new MessageTray.Source({
                    title: 'Monitor de VPN',
                    iconName: 'network-vpn-symbolic',
                });
                this._source.connect('destroy', () => {
                    this._source = null;
                });
                Main.messageTray.add(this._source);
            }
            const notification = new MessageTray.Notification({
                source: this._source,
                title,
                body,
                urgency: urgent ? MessageTray.Urgency.CRITICAL : MessageTray.Urgency.NORMAL,
            });
            this._source.addNotification(notification);
        } catch (e) {
            console.error(`vpn-monitor: ${e}`);
            Main.notify(title, body);
        }
    }
}
