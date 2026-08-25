import crypto from 'node:crypto'
import http from 'node:http'

/**
 * A real OIDC issuer, in-process: an RSA key pair, a JWKS endpoint that publishes its public
 * half, a discovery document, and a token minter. The node counterpart of the backend's
 * `TestOidcIssuer`, and for the same reason — an abstraction exercised by one implementation is
 * not an abstraction, so the OIDC path has to be proved against an issuer that is Firebase in no
 * respect: different keys, a different issuer URL, signed rather than unsigned, its own claims.
 *
 * The key id is fresh on every run, which is deliberate. The backend caches a JWKS for 15
 * minutes but refetches on an unknown `kid`, so a rerun inside that window verifies against the
 * new key rather than the previous run's stale one.
 */
const b64url = (input) => Buffer.from(input).toString('base64url')

export async function startOidcIssuer({ port = 29199, host = '127.0.0.1' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = `switchboard-live-${crypto.randomUUID()}`
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }
  const issuer = `http://${host}:${port}`

  const routes = {
    '/jwks.json': { keys: [jwk] },
    '/.well-known/openid-configuration': {
      issuer,
      jwks_uri: `${issuer}/jwks.json`,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      end_session_endpoint: `${issuer}/logout`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['RS256'],
    },
  }

  const server = http.createServer((req, res) => {
    const body = routes[new URL(req.url, issuer).pathname]
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body ?? { error: 'not_found' }))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })

  return {
    issuer,
    jwkSetUri: `${issuer}/jwks.json`,
    kid,
    /** A signed, currently-valid RS256 token over iss/sub/aud/iat/exp plus the given claims. */
    mint(subject, audience, claims = {}, lifetimeSeconds = 300) {
      const now = Math.floor(Date.now() / 1000)
      const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
      const payload = b64url(
        JSON.stringify({
          iss: issuer,
          sub: subject,
          aud: audience,
          iat: now,
          exp: now + lifetimeSeconds,
          ...claims,
        }),
      )
      const signature = crypto
        .sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey)
        .toString('base64url')
      return { token: `${header}.${payload}.${signature}`, expiresAt: now + lifetimeSeconds }
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
