import { AuthProvider } from './types';

export class PasswordProvider implements AuthProvider {
  readonly mode = 'password' as const;
  readonly requiresFreshTokenPerConnection = false;

  constructor(private readonly password: string) {}

  async getToken(): Promise<string> {
    return this.password;
  }
}
