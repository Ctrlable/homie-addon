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

bashio::log.info "Starting Homie Dashboard Proxy v1.1.9a"

# ── Read connection list from options.json ──────────────────
CONNECTIONS="$(jq -c '.connections // []' /data/options.json)"
export HOMIE_CONNECTIONS="${CONNECTIONS}"

# ── Port ────────────────────────────────────────────────────
export HOMIE_PORT="3001"

# ── Log level ───────────────────────────────────────────────
export HOMIE_LOG="${LOG_LEVEL:-info}"

bashio::log.info "Loaded $(jq 'length' <<< "${CONNECTIONS}") connection(s)"
bashio::log.info "Proxy listening on port ${HOMIE_PORT}"

# ── Launch proxy ────────────────────────────────────────────
exec node /app/proxy.js
