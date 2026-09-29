# Manual nodes with an external Mihomo service (Debian 13)

This mode serves MetaCubeXD and its node-management API without spawning a second Mihomo process. Run the dashboard server as a dedicated unprivileged Unix user. That user owns the manual Provider files, and Mihomo needs access to the Provider file for refreshes. Do not run the dashboard server as root.

## Prepare Mihomo

By default, create `/etc/mihomo/proxy_providers` with mode `0700` and owner set to the dashboard service user. On this VM Mihomo runs as UID/GID 0 with no DAC override capability and its `PUT` refresh opens the Provider file for writing. Use a directory owned by `metacubexd:root` with mode `2750` and `manual.txt` owned by `metacubexd:root` with mode `0660`. Set `MANUAL_PROVIDER_SHARED_GROUP=1` for the dashboard service. The setgid directory makes atomic replacement files retain the `root` group. Other users get no access. Metadata, key, and backup files remain `0600`.

Mihomo also rejects refreshing an empty Provider, including `proxies: []`. Initialize `manual.txt` with this safe placeholder, which remains visible only in Mihomo's general Provider view when no managed nodes exist:

```yaml
proxies:
  - name: 'Manual empty (DIRECT)'
    type: direct
```

When real nodes exist, the file contains only their URI lines. The node-management page excludes the placeholder from its list.

Add this to the active Mihomo config once:

```yaml
external-controller: 0.0.0.0:9090
proxy-providers:
  manual:
    type: file
    path: ./proxy_providers/manual.txt
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 600
```

Add `manual` to the intended proxy groups' `use` list. Apply this initial configuration with your normal Mihomo configuration reload. Confirm `GET /providers/proxies/manual` succeeds before importing nodes.

Changing the controller listen port can require one Mihomo service restart. Routine node edits only refresh the Provider and do not restart Mihomo.

If the dashboard server uses a different HTTP origin from Mihomo's controller, add that exact origin to Mihomo's `external-controller-cors.allow-origins`. On this VM, the controller listens on port 9090 and the dashboard origin is `http://192.168.100.12`:

```yaml
external-controller-cors:
  allow-origins:
    - http://192.168.100.12
  allow-private-network: true
```

## Run the dashboard server

Build the UI and server with `pnpm build:ui` and `pnpm build:server`. Run `apps/server/.output/server/index.mjs` as the dedicated `metacubexd` service user with these settings:

```ini
Environment=MIHOMO_MODE=external
Environment=MIHOMO_HOME=/etc/mihomo
Environment=MIHOMO_API_URL=http://127.0.0.1:9090
Environment=MANUAL_PROVIDER_SHARED_GROUP=1
Environment=HOST=192.168.100.12
Environment=PORT=80
Environment=CONTROL_TOKEN=<long-random-secret>
Environment=CLASH_SECRET=<existing-mihomo-api-secret>
Environment=DEFAULT_BACKEND_URL=http://192.168.100.12:9090
```

Place secrets in a root-owned systemd environment file with mode `0600`, referenced by `EnvironmentFile=`, rather than in a world-readable unit file. The non-root service needs `AmbientCapabilities=CAP_NET_BIND_SERVICE` and `CapabilityBoundingSet=CAP_NET_BIND_SERVICE` to listen on port 80. The UI and Control API are intended for a trusted LAN; restrict port 80 to trusted clients, preferably behind an authenticated reverse proxy. Do not publish the UI to the internet. The server's `/config.js` exposes the Control token to anyone who can load the UI, so protect the entire UI origin. The existing dashboard endpoint store also persists the Clash API secret in browser local storage; use a dedicated browser profile on a trusted device.

The node page appears only when `MIHOMO_MODE=external`. The node-management API stays on the Dashboard origin at `/api/control`; Mihomo's own API uses port 9090. `GET /api/control/system/status` reports whether Mihomo and the `manual` Provider are ready. Ordinary node edits write `manual.txt` and call Mihomo's Provider reload API; they do not restart the systemd service.

The node list can filter by name, protocol, tag, and availability. Its **Use** action selects a managed node in a Mihomo Selector group that already includes the `manual` Provider; it does not edit the main config. Deleting selected nodes uses one Provider transaction and one reload.

## Subscription links

Add two file Providers to the main Mihomo config once. The subscription manager writes URI lists to one file and Clash/Mihomo YAML proxies to the other, because Mihomo cannot mix those formats in one Provider file. Both files need the same `metacubexd:root` ownership and `0660` mode as `manual.txt`; the private `subscriptions.meta.json` stores source URLs and cached nodes with mode `0600`.

```yaml
proxy-providers:
  subscriptions-uri:
    type: file
    path: ./proxy_providers/subscriptions-uri.txt
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 600
  subscriptions-yaml:
    type: file
    path: ./proxy_providers/subscriptions-yaml.yaml
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 600
```

Include both names in the intended Selector group's `use` list, alongside `manual`. Initialize the files with `proxies:` YAML containing one `direct` placeholder each (named `Subscriptions URI empty (DIRECT)` and `Subscriptions YAML empty (DIRECT)`). Mihomo rejects a refresh of an empty Provider; after the first successful subscription update, its placeholder is replaced by real nodes.

The **Subscriptions** tab at `/nodes/subscriptions` previews, adds, edits, deletes, and refreshes sources. It accepts YAML with a `proxies` list, URI lines, and Base64 encoded URI lines. A zero hour interval disables automatic updates; other sources are checked every minute and fetched when due. Updates write both Provider files atomically, keep backups, reload them with Mihomo's API, verify loaded names, and restore the previous files if reload fails. A failed source download leaves the running nodes intact. Subscription URLs never appear in list responses, browser storage, or error messages; the edit dialog requests a URL only when opened. Access to this page and its Control API should remain limited to a trusted LAN.
