# Switchboard dashboard.
#
#     docker build -t switchboard-dashboard dashboard
#
# The interesting part of this image is what it does NOT bake in. A Vite build folds every
# `import.meta.env.VITE_*` into the bundle as a literal, so the obvious image is pinned to one
# API URL and one IdP -- staging and production would be different images of the same commit.
# Instead the entrypoint writes /config.js from the container's environment at start-up and the
# app layers it over the build-time defaults (src/lib/runtimeConfig.ts). One image, any
# environment.
#
# The exception is VITE_AUTH_PROVIDER, which is a genuine build ARG: src/auth/index.ts sits its
# two dynamic imports either side of a literal comparison so the bundler drops the losing branch
# entirely. A default build does not contain oidc-client-ts; an `oidc` build does not contain
# Firebase. That is the difference between not calling Firebase and not shipping it, and only
# the second is true here.
#
#     docker build --build-arg VITE_AUTH_PROVIDER=oidc -t switchboard-dashboard:oidc dashboard

# ---------------------------------------------------------------------------------------------
# Stage 1 - build
# ---------------------------------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /build

# The lockfile alone decides the dependency layer, so a source change reuses the install.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_AUTH_PROVIDER=firebase
ENV VITE_AUTH_PROVIDER=${VITE_AUTH_PROVIDER}
RUN npm run build

# ---------------------------------------------------------------------------------------------
# Stage 2 - runtime
# ---------------------------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# The unprivileged image already runs as uid 101 and listens on 8080 rather than 80, which is
# what makes it work under a read-only root filesystem and a restricted pod security context.
# The stock nginx image would need the port, the pid path and three cache directories rewritten
# to get to the same place.

COPY --chown=101:101 nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=101:101 /build/dist/ /usr/share/nginx/html/

# The base image runs everything here before starting nginx.
COPY --chown=101:101 docker-entrypoint.d/10-runtime-config.sh /docker-entrypoint.d/10-runtime-config.sh
USER root
RUN chmod +x /docker-entrypoint.d/10-runtime-config.sh
USER 101

EXPOSE 8080

# Asks for the page a browser would actually load. A check that only proves the port is open
# would pass on an image whose dist/ never got copied.
#
# 127.0.0.1 rather than localhost, and that is not pedantry: busybox wget resolves localhost to
# ::1 first, nginx here listens on 0.0.0.0 only, and the check fails with "connection refused"
# against a server that is serving perfectly. The base image ships a script to add an IPv6
# listener, but it skips any default.conf it did not write -- which is every custom config.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/index.html || exit 1
