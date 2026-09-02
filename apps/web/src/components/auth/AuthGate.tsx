import { ReactElement, ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Login } from '../../pages/Login';
import { Register } from '../../pages/Register';

export function AuthGate({ children }: { children: ReactNode }): ReactElement | null {
  const { loading, mode, bootstrapped, user } = useAuth();

  if (loading) {
    return null;
  }
  if (mode === 'disabled') {
    return <>{children}</>;
  }
  if (mode === 'self-hosted' && bootstrapped === false) {
    return (
      <Routes>
        <Route path="/register" element={<Register />} />
        <Route path="*" element={<Navigate to="/register" replace />} />
      </Routes>
    );
  }
  if (user === null) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/register" element={<Navigate to="/" replace />} />
      <Route path="*" element={<>{children}</>} />
    </Routes>
  );
}
