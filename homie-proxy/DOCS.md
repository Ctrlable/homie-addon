# Homie Dashboard Proxy

Secure WebSocket proxy for the Homie smart home dashboard.

## How it works

The proxy runs inside your Home Assistant instance. It:

1. **Serves the Homie dashboard** at `http://homeassistant.local:3001`
2. **Holds your HA tokens** — stored encrypted by HA Supervisor, never sent to the browser
3. **Proxies WebSocket connections** — the browser connects to the proxy; the proxy authenticates to HA using your token server-side

Your token never appears in any browser, network tab, log file, or HTML file.

## Setup

### 1. Add this repository

In Home Assistant go to:
**Settings → Add-ons → Add-on Store → ⋮ → Repositories**

Add:
```
https://github.com/Ctrlable/homie-addon
```

### 2. Install Homie Dashboard Proxy

Find **Homie Dashboard Proxy** in the store and click Install.

### 3. Configure your connections

Go to the addon **Configuration** tab and fill in your connections:

```yaml
connections:
  - id: home
    label: My Home
    ha_url: http://192.168.1.100:8123   # your HA local URL
    token: "eyJhbGci..."                # long-lived access token
    wan_url: https://ha.yourdomain.com  # optional external URL
```

You can add multiple connections for multi-property setups.

**To get a long-lived token:**
HA → Profile (bottom-left) → Security → Long-Lived Access Tokens → Create Token

### 4. Start the addon

Click **Start**. The dashboard is now available at:
- `http://homeassistant.local:3001` (direct)
- Via the HA sidebar panel (Ingress)

### 5. Create your dashboards

Open the Homie Manager, click **+ New Dashboard**, select your connection, and configure entities from there.

## Security notes

- Tokens are stored encrypted by HA Supervisor — not in plaintext files
- The browser never receives a token — not in HTML, JS, cookies, or WebSocket messages
- Rate limiting (10 connections/min per IP) protects against brute-force
- Every `call_service` action is logged with entity ID for audit trail
- For remote access, use your VPN or a Cloudflare Tunnel — don't expose port 3001 directly

## LAN / WAN auto-detection

If you configure both `ha_url` (LAN) and `wan_url` (WAN), the proxy tries the LAN URL first with a 1.5 second timeout. If unreachable, it falls back to the WAN URL automatically. This happens server-side — the browser always connects to the same proxy endpoint regardless of network.
