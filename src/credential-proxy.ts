/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/** Cached OAuth token with expiry metadata. */
let cachedOAuthToken: { value: string; expiresAt: number } | null = null;

/**
 * Resolve OAuth token by reading ~/.claude/.credentials.json on demand.
 * Caches the token in memory and re-reads when within 5 minutes of expiry.
 * Falls back to .env CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN.
 */
function resolveOAuthToken(): string | undefined {
  const now = Date.now();
  const FIVE_MINUTES = 5 * 60 * 1000;

  // Return cached token if still valid (5-min buffer)
  if (
    cachedOAuthToken &&
    cachedOAuthToken.expiresAt > 0 &&
    cachedOAuthToken.expiresAt - now > FIVE_MINUTES
  ) {
    return cachedOAuthToken.value;
  }

  // Try credentials.json first
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    const oauth = creds.claudeAiOauth;
    if (oauth?.accessToken) {
      cachedOAuthToken = {
        value: oauth.accessToken,
        expiresAt: oauth.expiresAt || 0,
      };
      logger.info('OAuth token refreshed from credentials.json');
      return oauth.accessToken;
    }
  } catch {
    // credentials.json not found or unreadable — fall through to .env
  }

  // Fallback to .env
  const envSecrets = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  const fallback =
    envSecrets.CLAUDE_CODE_OAUTH_TOKEN || envSecrets.ANTHROPIC_AUTH_TOKEN;
  if (fallback) {
    logger.info('OAuth token loaded from .env fallback');
  }
  return fallback;
}

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            const token = resolveOAuthToken();
            if (token) {
              headers['authorization'] = `Bearer ${token}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Reset cached OAuth token (for testing). */
export function resetOAuthTokenCache(): void {
  cachedOAuthToken = null;
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
