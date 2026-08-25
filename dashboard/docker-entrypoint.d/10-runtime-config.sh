#!/bin/sh
# Write the runtime configuration the app reads, from this container's environment.
#
# nginx's official image runs everything in /docker-entrypoint.d before starting, so this lands
# before the first request. It rewrites the `config.js` that the build shipped, and the browser
# evaluates it ahead of the bundle (index.html loads it as a classic script; see
# src/lib/runtimeConfig.ts for why this exists at all).
#
# Only variables that are actually SET are emitted. A blank value would otherwise shadow the
# build-time default with an empty string, which for VITE_API_BASE_URL means the app quietly
# calls its own origin and every request 404s against the static server.
set -eu

TARGET="${SWITCHBOARD_CONFIG_PATH:-/usr/share/nginx/html/config.js}"

# VITE_AUTH_PROVIDER is deliberately NOT in this list: it decides which provider is compiled
# into the bundle, so it is a build argument (see the Dockerfile's ARG). Setting it here would
# be reported by the app as a configuration error rather than silently ignored.
KEYS="VITE_API_BASE_URL
VITE_FIREBASE_PROVIDER_NAME
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_APP_ID
VITE_FIREBASE_AUTH_EMULATOR_HOST
VITE_OIDC_AUTHORITY
VITE_OIDC_CLIENT_ID
VITE_OIDC_SCOPE
VITE_OIDC_AUDIENCE
VITE_OIDC_PROVIDER_NAME
VITE_OIDC_REDIRECT_URI
VITE_OIDC_SILENT_REDIRECT_URI
VITE_OIDC_POST_LOGOUT_REDIRECT_URI"

# Escaping: these values reach a browser inside a JS string literal. A backslash or a quote in a
# URL is unlikely but an unescaped one would be a script-injection hole in the page's own
# configuration, so it is not left to luck. `</script` is broken up for the same reason -- an
# HTML parser ends the block on that sequence no matter where it appears.
escape() {
    printf '%s' "$1" \
        | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's|</script|<\\/script|g'
}

{
    echo '// Generated at container start-up. Edits here are lost on restart.'
    echo 'window.__SWITCHBOARD_CONFIG__ = {'
    for key in $KEYS; do
        # POSIX-safe indirect expansion; `set -u` makes an unset variable an error otherwise.
        value=$(eval "printf '%s' \"\${$key-}\"")
        [ -n "$value" ] || continue
        printf '  "%s": "%s",\n' "$key" "$(escape "$value")"
    done
    echo '}'
} > "$TARGET"

echo "[switchboard] wrote $TARGET"
