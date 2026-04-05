const REGISTRATION_URL = import.meta.env.VITE_REGISTRATION_URL || 'http://localhost:3001/v1/registrations';

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
