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
 *
 * Auto-refresh:
 *   In OAuth mode, a background loop refreshes the access token before
 *   it expires using the refresh token from ~/.claude/.credentials.json.
 *   This keeps the bot running even when Claude Code is not active.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const THIRTY_MINUTES = 30 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const REFRESH_CHECK_INTERVAL = 10 * 60 * 1000; // Check every 10 minutes

/** Cached OAuth token with expiry metadata. */
let cachedOAuthToken: {
  value: string;
  expiresAt: number;
  refreshToken?: string;
} | null = null;

/** Background refresh interval handle. */
let refreshIntervalHandle: ReturnType<typeof setInterval> | null = null;

/** Whether a refresh is currently in progress (prevents concurrent refreshes). */
let refreshInProgress = false;

/**
 * Read credentials from ~/.claude/.credentials.json.
 * Returns the claudeAiOauth object or null if unavailable.
 */
function readCredentials(): {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null {
  try {
    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
    const oauth = creds.claudeAiOauth;
    if (oauth?.accessToken && oauth?.refreshToken) {
      return {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt || 0,
      };
    }
  } catch {
    // credentials.json not found or unreadable
  }
  return null;
}

/**
 * Write updated tokens back to ~/.claude/.credentials.json.
 * Preserves all other fields (mcpOAuth, etc).
 */
function writeCredentials(
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
): void {
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
    const creds = JSON.parse(raw);
    creds.claudeAiOauth = {
      ...creds.claudeAiOauth,
      accessToken,
      refreshToken,
      expiresAt,
    };
    writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds), 'utf-8');
    logger.info('Updated credentials.json with refreshed token');
  } catch (err) {
    logger.error({ err }, 'Failed to write updated credentials.json');
  }
}

/**
 * Perform an OAuth token refresh using the refresh token.
 * Calls https://platform.claude.com/v1/oauth/token with grant_type=refresh_token.
 * Returns the new access token or null on failure.
 */
export function performOAuthRefresh(
  refreshToken: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null> {
  if (refreshInProgress) {
    logger.debug('Token refresh already in progress, skipping');
    return Promise.resolve(null);
  }

  refreshInProgress = true;

  return new Promise((resolve) => {
    const postBody = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const url = new URL(TOKEN_ENDPOINT);
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(postBody),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          refreshInProgress = false;
          const body = Buffer.concat(chunks).toString();

          if (res.statusCode !== 200) {
            logger.error(
              { statusCode: res.statusCode, body: body.slice(0, 200) },
              'OAuth token refresh failed',
            );
            resolve(null);
            return;
          }

          try {
            const data = JSON.parse(body);
            const accessToken = data.access_token;
            const newRefreshToken = data.refresh_token || refreshToken;
            // expires_in is in seconds
            const expiresIn = data.expires_in || 43200;
            const expiresAt = Date.now() + expiresIn * 1000;

            if (!accessToken) {
              logger.error('OAuth refresh response missing access_token');
              resolve(null);
              return;
            }

            logger.info(
              {
                expiresIn: `${Math.round(expiresIn / 60)}min`,
                hasNewRefreshToken: newRefreshToken !== refreshToken,
              },
              'OAuth token refreshed successfully',
            );

            resolve({
              accessToken,
              refreshToken: newRefreshToken,
              expiresAt,
            });
          } catch (err) {
            logger.error({ err }, 'Failed to parse OAuth refresh response');
            resolve(null);
          }
        });
      },
    );

    req.on('error', (err) => {
      refreshInProgress = false;
      logger.error({ err }, 'OAuth token refresh request failed');
      resolve(null);
    });

    req.write(postBody);
    req.end();
  });
}

/**
 * Try to refresh the OAuth token if it's near expiry.
 * Updates both the in-memory cache and credentials.json.
 */
async function tryRefreshIfNeeded(): Promise<void> {
  const creds = readCredentials();
  if (!creds) return;

  const now = Date.now();
  const timeUntilExpiry = creds.expiresAt - now;

  // Only refresh if within 30 minutes of expiry
  if (timeUntilExpiry > THIRTY_MINUTES) {
    logger.debug(
      { minutesUntilExpiry: Math.round(timeUntilExpiry / 60000) },
      'Token still valid, skipping refresh',
    );
    return;
  }

  logger.info(
    { minutesUntilExpiry: Math.round(timeUntilExpiry / 60000) },
    'Token near expiry, attempting refresh',
  );

  const result = await performOAuthRefresh(creds.refreshToken);
  if (result) {
    // Update in-memory cache
    cachedOAuthToken = {
      value: result.accessToken,
      expiresAt: result.expiresAt,
      refreshToken: result.refreshToken,
    };

    // Persist to credentials.json
    writeCredentials(
      result.accessToken,
      result.refreshToken,
      result.expiresAt,
    );
  }
}

/**
 * Start a background loop that checks and refreshes the token periodically.
 * Runs every 10 minutes and refreshes when within 30 minutes of expiry.
 */
export function startTokenRefreshLoop(): void {
  if (refreshIntervalHandle) return;

  // Initial check after 5 seconds (let startup complete)
  setTimeout(() => {
    tryRefreshIfNeeded().catch((err) =>
      logger.error({ err }, 'Initial token refresh check failed'),
    );
  }, 5000);

  // Periodic check every 10 minutes
  refreshIntervalHandle = setInterval(() => {
    tryRefreshIfNeeded().catch((err) =>
      logger.error({ err }, 'Periodic token refresh check failed'),
    );
  }, REFRESH_CHECK_INTERVAL);

  // Don't let the interval keep the process alive
  if (refreshIntervalHandle.unref) {
    refreshIntervalHandle.unref();
  }

  logger.info(
    { intervalMinutes: REFRESH_CHECK_INTERVAL / 60000 },
    'Token refresh loop started',
  );
}

/**
 * Stop the background token refresh loop.
 */
export function stopTokenRefreshLoop(): void {
  if (refreshIntervalHandle) {
    clearInterval(refreshIntervalHandle);
    refreshIntervalHandle = null;
    logger.info('Token refresh loop stopped');
  }
}

/**
 * Resolve OAuth token by reading ~/.claude/.credentials.json on demand.
 * Caches the token in memory and re-reads when within 5 minutes of expiry.
 * Falls back to .env CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN.
 */
function resolveOAuthToken(): string | undefined {
  const now = Date.now();

  // Return cached token if still valid (5-min buffer)
  if (
    cachedOAuthToken &&
    cachedOAuthToken.expiresAt > 0 &&
    cachedOAuthToken.expiresAt - now > FIVE_MINUTES
  ) {
    return cachedOAuthToken.value;
  }

  // Try credentials.json first
  const creds = readCredentials();
  if (creds) {
    cachedOAuthToken = {
      value: creds.accessToken,
      expiresAt: creds.expiresAt,
      refreshToken: creds.refreshToken,
    };

    // If token is near expiry, trigger async refresh (non-blocking)
    if (creds.expiresAt - now < THIRTY_MINUTES) {
      tryRefreshIfNeeded().catch((err) =>
        logger.error({ err }, 'On-demand token refresh failed'),
      );
    }

    logger.info('OAuth token refreshed from credentials.json');
    return creds.accessToken;
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

  // Start background token refresh in OAuth mode
  if (authMode === 'oauth') {
    startTokenRefreshLoop();
  }

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
