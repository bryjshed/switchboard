/**
 * LOCAL-FIRST AUTH BRIDGE.
 *
 * Signs in against the Firebase Auth EMULATOR's REST API (identitytoolkit) and
 * uses the returned (unsigned) idToken as the Bearer token for the backend's
 * local profile. This is the seam where @react-native-firebase/auth lands in a
 * later slice: swap these two functions for the native SDK's
 * signInWithEmailAndPassword/createUserWithEmailAndPassword + getIdToken and
 * nothing above this module changes.
 */
import { config } from '@shared/config';
import { ApiClientError, NetworkError } from '@shared/api/client';

export interface EmulatorSession {
  idToken: string;
  refreshToken: string;
  localId: string;
  email: string;
}

interface IdentityToolkitResponse {
  idToken: string;
  refreshToken: string;
  localId: string;
  email: string;
}

interface IdentityToolkitError {
  error?: { message?: string };
}

async function identityToolkit(endpoint: string, body: unknown): Promise<EmulatorSession> {
  const url = `${config.firebaseEmulatorUrl}/identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${config.firebaseApiKey}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : 'Auth emulator unreachable');
  }
  if (!response.ok) {
    let message = `Sign-in failed (${response.status})`;
    try {
      const payload = (await response.json()) as IdentityToolkitError;
      if (payload.error?.message) message = payload.error.message;
    } catch {
      // keep default message
    }
    throw new ApiClientError('UNAUTHORIZED', message, response.status);
  }
  return (await response.json()) as IdentityToolkitResponse;
}

export function emulatorSignIn(email: string, password: string): Promise<EmulatorSession> {
  return identityToolkit('signInWithPassword', { email, password, returnSecureToken: true });
}

export function emulatorSignUp(email: string, password: string): Promise<EmulatorSession> {
  return identityToolkit('signUp', { email, password, returnSecureToken: true });
}
