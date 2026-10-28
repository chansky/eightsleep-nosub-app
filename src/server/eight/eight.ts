// eight.ts
import { z } from 'zod';
import { DeviceDataSchema, DeviceListSchema, type Token } from './types';
import { CLIENT_API_URL, APP_API_URL, DEFAULT_API_HEADERS } from './constants';
import { describeDiagnosticError, recordDiagnosticEvent } from '~/server/temperature-diagnostics';

export class ApiRequestError extends Error {
  constructor(public statusCode: number) {
    super(`Eight Sleep API request failed: ${statusCode}`);
    this.name = 'ApiRequestError';
  }
}

function diagnosticEndpoint(url: string): string {
  const endpoint = new URL(url);
  // Keep endpoint names useful without retaining user/device identifiers or query values.
  return `${endpoint.hostname}${endpoint.pathname
    .replace(/\/users\/(?!me(?:\/|$))[^/]+/g, '/users/:userId')
    .replace(/\/devices\/[^/]+/g, '/devices/:deviceId')}`;
}

export async function fetchWithAuth<T extends z.ZodType<unknown, z.ZodTypeDef, unknown>>(
  url: string, 
  token: Token, 
  schema: T, 
  options: RequestInit = {}
): Promise<z.infer<T>> {
  const startedAt = Date.now();
  const request = { method: options.method ?? 'GET', endpoint: diagnosticEndpoint(url) };
  recordDiagnosticEvent('api.request', request);
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...DEFAULT_API_HEADERS,
        ...options.headers,
        authorization: `Bearer ${token.eightAccessToken}`,
      },
    });
    recordDiagnosticEvent('api.response', {
      ...request, status: response.status, ok: response.ok, durationMs: Date.now() - startedAt,
    });
    if (!response.ok) {
      throw new ApiRequestError(response.status);
    }
    const data: unknown = await response.json();
    return schema.parse(data);
  } catch (error) {
    recordDiagnosticEvent('api.failure', {
      ...request, durationMs: Date.now() - startedAt, ...describeDiagnosticError(error),
    });
    throw error;
  }
}

export async function fetchDeviceList(token: Token): Promise<string[]> {
  const url = `${CLIENT_API_URL}/users/me`;
  const data = await fetchWithAuth(url, token, DeviceListSchema);
  return data.user.devices;
}



export async function getDeviceData(token: Token, deviceId: string, options: RequestInit = {}): Promise<z.infer<typeof DeviceDataSchema>['result']> {
  const url = `${CLIENT_API_URL}/devices/${deviceId}`;
  const data = await fetchWithAuth(url, token, DeviceDataSchema, options);
  return data.result;
}

export async function setHeatingLevel(token: Token, userId: string, level: number, duration = 0): Promise<void> {
  recordDiagnosticEvent('temperature.command', { level, durationSeconds: duration });
  const url = `${APP_API_URL}v1/users/${userId}/temperature`;
  const data = {
    timeBased: { level, durationSeconds: duration },
    currentLevel: level,
  };

  await fetchWithAuth(url, token, z.object({}), {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function setSmartHeatingLevel(token: Token, userId: string, level: number, sleepStage: string): Promise<void> {
  const url = `${APP_API_URL}v1/users/${userId}/temperature`;

  // First, get current smart heating levels
  const currentData = await fetchWithAuth(url, token, z.object({ smart: z.record(z.number()) }));
  const smartLevels = currentData.smart;
  smartLevels[sleepStage] = level;

  // Now, update with new level
  await fetchWithAuth(url, token, z.object({}), {
    method: 'PUT',
    body: JSON.stringify({ smart: smartLevels }),
  });
}

export async function turnOnSide(token: Token, userId: string): Promise<void> {
  recordDiagnosticEvent('temperature.state-command', { state: 'smart' });
  const url = `${APP_API_URL}v1/users/${userId}/temperature`;
  const data = { currentState: { type: "smart" } };

  await fetchWithAuth(url, token, z.object({}), {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function turnOffSide(token: Token, userId: string): Promise<void> {
  recordDiagnosticEvent('temperature.state-command', { state: 'off' });
  const url = `${APP_API_URL}v1/users/${userId}/temperature`;
  const data = { currentState: { type: "off" } };

  await fetchWithAuth(url, token, z.object({}), {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}
