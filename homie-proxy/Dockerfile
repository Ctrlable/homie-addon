ARG BUILD_FROM=ghcr.io/home-assistant/base:latest
FROM ${BUILD_FROM}

# ── Labels required by HA Supervisor ──────────────────────────────────────
LABEL \
  io.hass.name="Homie Dashboard Proxy" \
  io.hass.description="Secure WebSocket proxy for the Homie dashboard" \
  io.hass.type="addon" \
  io.hass.version="1.1.8" \
  io.hass.arch="aarch64|amd64|armhf|armv7|i386" \
  maintainer="Ctrlable <dev@ctrlable.com>"

# ── Install Node.js 22 + npm from Alpine edge ──────────────────────────────
# The HA base image is Alpine-based; node22 is in the community repo.
RUN apk add --no-cache \
      nodejs \
      npm \
    && node --version \
    && npm --version

# ── Install bashio helper (already in HA base, but pin explicitly) ─────────
# bashio lets run.sh read options.json cleanly
# It is pre-installed in ghcr.io/home-assistant/base — nothing to add.

# ── Copy addon files ──────────────────────────────────────────────────────
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY proxy.js     ./
COPY run.sh       /run.sh
RUN chmod +x /run.sh

# ── Static dashboard files served by the proxy ────────────────────────────
# homie.html + config.js (generated at runtime, no token inside)
COPY www/ ./www/

EXPOSE 3001
CMD ["/run.sh"]
