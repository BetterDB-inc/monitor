import { useAuth } from '../contexts/AuthContext';

export function useCanMutate(): boolean {
  const { mode, user } = useAuth();
  if (mode !== 'self-hosted') {
    return true;
  }
  if (user === null) {
    return false;
  }
  return user.role === 'admin';
}
