<div align="center">

# 🛡️ Monitor de VPN

**Tus VPN a la vista en la barra de GNOME: estado en tiempo real, conexión con un clic y reconexión automática cuando se caen.**

![GNOME Shell](https://img.shields.io/badge/GNOME_Shell-46_%E2%80%93_50-4A86CF?logo=gnome&logoColor=white)
![NetworkManager](https://img.shields.io/badge/NetworkManager-compatible-2EC27E)
![WireGuard](https://img.shields.io/badge/WireGuard-wg--quick-88171A?logo=wireguard&logoColor=white)
![OpenVPN](https://img.shields.io/badge/OpenVPN-compatible-EA7E20?logo=openvpn&logoColor=white)
![Licencia](https://img.shields.io/badge/licencia-Apache_2.0-blue)

</div>

---

## ¿Por qué?

Las VPN se caen sin avisar y te enteras cuando algo deja de funcionar. Esta extensión las vigila por ti: te dice en todo momento cuáles están conectadas, te avisa cuando una se cae y, si quieres, la vuelve a levantar sola. Todo desde la barra superior, sin abrir una terminal.

## ✨ Funciones

| | |
|---|---|
| 🚦 **Estado de un vistazo** | El icono cambia de color: 🟢 alguna conectada · 🟠 conectando · 🔴 alguna caída o sin tráfico · ⚪ ninguna activa. |
| 🔌 **Conectar y desconectar** | Un clic sobre la VPN la activa o la desactiva. |
| ↻ **Refrescar** | Baja la conexión y la vuelve a levantar. |
| ⟳ **Reconexión automática** | Elige qué VPN deben mantenerse vivas. Si una de ellas estaba conectada y se cae, la extensión te avisa y la reintenta con espera creciente (5 s, 10 s, 20 s… hasta 5 min). Sin red, espera sin gastar intentos. |
| 🔔 **Notificaciones** | Aviso cuando una VPN se cae, se recupera o no se puede recuperar. |
| 🩺 **Comprobación de tráfico** | Opcional: un `host:puerto` interno al que solo se llega por la VPN. Detecta túneles que siguen «conectados» pero ya no pasan tráfico. |
| 🧩 **Cualquier VPN** | Las guardadas en NetworkManager (OpenVPN, WireGuard, OpenConnect, L2TP, IPsec…) y las que se levantan con comandos (`wg-quick`, `openvpn`, scripts propios). |

> Solo se reconectan las VPN marcadas con ⟳ que **estaban conectadas y se caen**. Si la desconectas tú desde el menú, se queda desconectada.

## 📦 Instalación

### Desde la release

```bash
gnome-extensions install --force vpn-monitor@mgomezbuceta.shell-extension.zip
```

### Desde el código

```bash
git clone git@github.com:mgomezbuceta/gnome-vpn-monitor.git
cd gnome-vpn-monitor
cp vpns.example.json vpns.json   # opcional: tus VPN por comandos
./install.sh
```

Después recarga GNOME y actívala:

- **X11**: <kbd>Alt</kbd>+<kbd>F2</kbd> → `r` → <kbd>Intro</kbd>
- **Wayland**: cierra sesión y vuelve a entrar

```bash
gnome-extensions enable vpn-monitor@mgomezbuceta
```

## ⚙️ Configuración

Abre las preferencias desde el propio menú o con:

```bash
gnome-extensions prefs vpn-monitor@mgomezbuceta
```

### VPN por comandos

Para las VPN que NetworkManager no gestiona. Se añaden en **Preferencias → VPN por comandos** o en un `vpns.json` junto a `install.sh` (se carga en la primera instalación; `./install.sh --reset-vpns` lo vuelve a cargar).

```json
[
  {
    "id": "oficina",
    "name": "Oficina",
    "kind": "WireGuard",
    "up": "sudo -n wg-quick up wg0",
    "down": "sudo -n wg-quick down wg0",
    "status": "ip link show dev wg0 >/dev/null 2>&1"
  }
]
```

| Campo | Para qué sirve |
|---|---|
| `id` | Identificador único (sin espacios). |
| `name` / `kind` | Nombre y tipo que se muestran en el menú. |
| `up` / `down` | Comandos para conectar y desconectar. Si necesitan root, usa `sudo -n` (requiere sudo sin contraseña para ese comando). |
| `status` | Comando que sale con código `0` si la VPN está conectada. Se ejecuta cada 10 s (configurable). |

Al reconectar tras una caída se ejecuta primero `down` y luego `up`, por si quedó a medias.

<details>
<summary><b>Recetas de <code>status</code></b></summary>

- **WireGuard con `PersistentKeepalive`** (comprueba que hubo handshake en los últimos 3 min):
  ```sh
  h=$(sudo -n wg show wg0 latest-handshakes 2>/dev/null | cut -f2); [ -n "$h" ] && [ $(( $(date +%s) - h )) -lt 180 ]
  ```
- **WireGuard sin keepalive**: `ip link show dev wg0 >/dev/null 2>&1`
- **OpenVPN como servicio systemd**: `systemctl is-active --quiet openvpn-client@ejemplo`

</details>

### Opciones generales

| Opción | Por defecto |
|---|---|
| Notificaciones | activadas |
| Reintentos máximos de reconexión (0 = sin límite) | 10 |
| Intervalo del comando de estado | 10 s |
| Intervalo de la comprobación de tráfico | 30 s |

## 🔒 Seguridad

La extensión ejecuta los comandos de las VPN por comandos con `/bin/sh` y **tu usuario**, sin privilegios propios. Antes de usarla en un equipo de trabajo:

- **Nada de secretos en los comandos ni en `vpns.json`.** Se guardan en texto plano en tu configuración de GNOME (dconf). Deja las credenciales en ficheros propios con permisos `600` o en el llavero.
- **La salida de los comandos se descarta.** Nunca aparece en notificaciones (que pueden verse en la pantalla de bloqueo) ni se guarda.
- **`sudo` acotado, no `NOPASSWD: ALL`.** Da permiso solo a los comandos exactos que usa la extensión, con argumentos fijos:

  ```sudoers
  # /etc/sudoers.d/vpn-monitor  (edítalo con: sudo visudo -f /etc/sudoers.d/vpn-monitor)
  tu_usuario ALL=(root) NOPASSWD: /usr/bin/wg-quick up wg0, /usr/bin/wg-quick down wg0, /usr/bin/wg show wg0 latest-handshakes
  Defaults!/usr/bin/wg !syslog
  ```

  Cualquier script que lances con `sudo` debe ser **propiedad de root y no escribible por tu usuario** (por ejemplo en `/usr/local/sbin`, `root:root 755`); si no, quien pueda editarlo tendrá root. Lo mismo para las configuraciones de WireGuard (`root:root 600`): `wg-quick` ejecuta como root sus `PostUp`/`PostDown`.
- **Comprobación de tráfico:** usa una IP interna en vez de un nombre para no filtrar nombres internos al DNS público cuando la VPN está caída.
- **Notificaciones:** incluyen el nombre de la VPN. Si no quieres que se vean con la sesión bloqueada, desactiva las notificaciones en la pantalla de bloqueo en *Configuración → Notificaciones*.

## 🗂️ Estructura

```
├── extension.js        # Indicador, menú y lógica de vigilancia/reconexión
├── prefs.js            # Ventana de preferencias (libadwaita)
├── stylesheet.css      # Colores de estado
├── metadata.json
├── schemas/            # Esquema GSettings
├── install.sh          # Instalación para el usuario actual
└── vpns.example.json   # Ejemplo de VPN por comandos
```

## 🐞 Depuración

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i vpn
```

## 📋 Requisitos

- GNOME Shell 46 o superior (Ubuntu 24.04+, Fedora 40+…)
- NetworkManager para las VPN guardadas en él
- Para VPN por comandos con root: `sudo` sin contraseña para esos comandos

## 📄 Licencia

[Apache 2.0](LICENSE)
