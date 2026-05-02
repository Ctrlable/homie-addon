# Homie Addon Repository

[![Add to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FCtrlable%2Fhomie-addon)

Custom Home Assistant addon repository for the **Homie Dashboard**.

## Addons

| Addon | Description |
|-------|-------------|
| [Homie Dashboard Proxy](./homie-proxy) | Secure WS proxy + dashboard server. Token never reaches the browser. |

## Installation

Click the button above, or manually add this repository URL in HA:

```
https://github.com/Ctrlable/homie-addon
```

**Settings → Add-ons → Add-on Store → ⋮ → Repositories**

## Repository structure

```
homie-addon/
├── repository.yaml          ← HA repository manifest
├── .github/workflows/
│   └── build.yml            ← Multi-arch Docker build + ghcr.io push
└── homie-proxy/
    ├── config.yaml          ← Addon manifest & options schema
    ├── Dockerfile           ← Alpine + Node.js 22
    ├── run.sh               ← Startup script (reads options.json)
    ├── proxy.js             ← WS proxy server (~200 lines)
    ├── package.json
    ├── DOCS.md              ← Shown in HA addon store
    ├── CHANGELOG.md
    └── www/
        └── homie.html       ← Dashboard (no credentials)
```

## Security model

```
Browser ──(ws, no token)──► Proxy (inside HA addon container)
                                │
                         reads token from
                         options.json (HA encrypted)
                                │
                                └──(ws + token)──► Home Assistant
```

The HA long-lived token lives only in `options.json`, which is encrypted at rest by HA Supervisor. It never appears in any HTML, JavaScript, browser memory, or network response sent to the browser.
