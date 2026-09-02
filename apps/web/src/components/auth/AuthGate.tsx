import { ReactElement, ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Login } from '../../pages/Login';
import { Register } from '../../pages/Register';
import { AuthUnavailable } from './AuthUnavailable';

export function AuthGate({ children }: { children: ReactNode }): ReactElement {
  const { loading, unavailable, mode, bootstrapped, user, refresh } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }
  if (unavailable) {
    return (
      <AuthUnavailable
        onRetry={() => {
          refresh();
        }}
      />
    );
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
  if (mode === 'cloud') {
    return <>{children}</>;
  }
  if (user === null) {
    const target = `${location.pathname}${location.search}`;
    const loginTarget =
      location.pathname === '/' ? '/login' : `/login?next=${encodeURIComponent(target)}`;
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to={loginTarget} replace />} />
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
