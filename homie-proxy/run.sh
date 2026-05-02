#!/usr/bin/with-contenv bashio
# ============================================================
# Homie Dashboard Proxy — startup script
# ============================================================
# bashio reads /data/options.json (written by HA Supervisor
# from the addon Configuration tab) and exports values as
# environment variables for proxy.js.
#
# The token NEVER leaves this container — it goes:
#   options.json (encrypted at rest by HA) → env var → proxy.js
#   and is used only to authenticate the server-side WS to HA.
# ============================================================

bashio::log.info "Starting Homie Dashboard Proxy v1.0.0"

# ── Read connection list from options.json ──────────────────
# Read /data/options.json directly — more reliable than piping bashio for arrays.
CONNECTIONS="$(python3 -c "
import json
with open('/data/options.json') as f:
    opts = json.load(f)
print(json.dumps(opts.get('connections', [])))
")"

export HOMIE_CONNECTIONS="${CONNECTIONS}"

# ── Port ────────────────────────────────────────────────────
export HOMIE_PORT="3001"

# ── Log level ───────────────────────────────────────────────
export HOMIE_LOG="${LOG_LEVEL:-info}"

bashio::log.info "Loaded $(python3 -c "import json; print(len(json.loads('''${CONNECTIONS}''')))" 2>/dev/null || echo '?') connection(s)"
bashio::log.info "Proxy listening on port ${HOMIE_PORT}"
bashio::log.info "Dashboard available at http://homeassistant.local:${HOMIE_PORT}"

# ── Launch proxy ────────────────────────────────────────────
exec node /app/proxy.js
