// Runtime configuration, read by `src/lib/runtimeConfig.ts`.
//
// This copy is the DEVELOPMENT one and is deliberately empty: with no overrides the app falls
// back to the build-time defaults in `.env.local` / `.env.example`, which is what a clean
// checkout wants. It exists at all so `/config.js` is a 200 rather than a 404 in the dev
// server's console.
//
// In a container this file is REWRITTEN at start-up from the environment (see
// `dashboard/docker-entrypoint.d/10-runtime-config.sh`), which is what lets one built image
// serve staging and production without a rebuild.
//
// `VITE_AUTH_PROVIDER` is not settable here. It decides which auth implementation is compiled
// into the bundle, so it is a build argument; setting it here is reported as an error rather
// than ignored.
window.__SWITCHBOARD_CONFIG__ = {}
