// Default to the canonical www host: the apex betterdb.com 307-redirects to www,
// and browsers don't follow redirects on CORS preflights — so the apex would
// silently break in-app registration. Set VITE_REGISTRATION_URL at build time
// (or in dev) to point at a local entitlement service for testing.
const REGISTRATION_URL = import.meta.env.VITE_REGISTRATION_URL || 'https://www.betterdb.com/api/register';

export interface RegistrationResponse {
  message: string;
}

export const registrationApi = {
  async register(email: string): Promise<RegistrationResponse> {
    const response = await fetch(REGISTRATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Registration failed' }));
      throw new Error(error.message || `Registration failed: ${response.status}`);
    }

    return response.json();
  },
};
