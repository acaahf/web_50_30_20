// js/services/securityService.js — Módulo de seguridad con PIN (SHA-256) y WebAuthn
const PIN_PREFIX = 'budget_pin_hash_';
const BIO_PREFIX = 'budget_bio_cred_';
const LOCK_PREFIX = 'budget_locked_';

/** Genera un digest SHA-256 salado para el PIN de 4 dígitos usando Web Crypto API */
async function hashPin(pin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(`salt_503020_${pin}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function savePin(userId, pin) {
  if (!/^\d{4}$/.test(pin)) {
    throw new Error('El PIN debe contener exactamente 4 dígitos numéricos.');
  }
  const hash = await hashPin(pin);
  localStorage.setItem(`${PIN_PREFIX}${userId}`, hash);
}

export async function verifyPin(userId, pin) {
  const stored = localStorage.getItem(`${PIN_PREFIX}${userId}`);
  if (!stored) return false;
  const hash = await hashPin(pin);
  return hash === stored;
}

export function hasPinConfigured(userId) {
  return Boolean(localStorage.getItem(`${PIN_PREFIX}${userId}`));
}

export function removePin(userId) {
  localStorage.removeItem(`${PIN_PREFIX}${userId}`);
  localStorage.removeItem(`${BIO_PREFIX}${userId}`); // Al borrar el PIN, quitamos la biometría por seguridad
  unlockScreen(userId);
}

/* --- Biometría (WebAuthn) --- */

export async function isBiometricsSupported() {
  return Boolean(
    window.PublicKeyCredential &&
    (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.())
  );
}

export async function registerBiometrics(userId, userEmail) {
  if (!(await isBiometricsSupported())) {
    throw new Error('Tu dispositivo o navegador no soporta autenticación biométrica.');
  }

  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'Presupuesto 50/30/20' },
      user: {
        id: new TextEncoder().encode(userId),
        name: userEmail,
        displayName: userEmail
      },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required'
      },
      timeout: 60000
    }
  });

  if (credential) {
    const rawId = Array.from(new Uint8Array(credential.rawId))
      .map((b) => String.fromCharCode(b))
      .join('');
    localStorage.setItem(`${BIO_PREFIX}${userId}`, btoa(rawId));
    return true;
  }
  return false;
}

export function hasBiometricsConfigured(userId) {
  return Boolean(localStorage.getItem(`${BIO_PREFIX}${userId}`));
}

export function disableBiometrics(userId) {
  localStorage.removeItem(`${BIO_PREFIX}${userId}`);
}

export async function verifyBiometrics(userId) {
  const credIdB64 = localStorage.getItem(`${BIO_PREFIX}${userId}`);
  if (!credIdB64) return false;

  const rawId = Uint8Array.from(atob(credIdB64), (c) => c.charCodeAt(0));
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: rawId, type: 'public-key' }],
      userVerification: 'required',
      timeout: 60000
    }
  });

  return Boolean(assertion);
}

/* --- Bloqueo de pantalla --- */

export function isScreenLocked(userId) {
  return sessionStorage.getItem(`${LOCK_PREFIX}${userId}`) === 'true';
}

export function lockScreen(userId) {
  sessionStorage.setItem(`${LOCK_PREFIX}${userId}`, 'true');
}

export function unlockScreen(userId) {
  sessionStorage.setItem(`${LOCK_PREFIX}${userId}`, 'false');
}