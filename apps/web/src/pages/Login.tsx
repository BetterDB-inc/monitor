import { ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { UnauthorizedError } from '../api/client';
import { workspaceApi } from '../api/workspace';
import { useAuth } from '../contexts/AuthContext';
import { BrokerButtons } from '../components/auth/BrokerButtons';
import { brokerErrorMessage } from '../components/auth/broker-errors';
import { CredentialsForm } from '../components/auth/CredentialsForm';
import { resolveNext } from '../components/auth/resolve-next';

export function Login(): ReactElement {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { refresh } = useAuth();

  return (
    <CredentialsForm
      title="Sign in"
      submitLabel="Sign in"
      askName={false}
      notice={brokerErrorMessage(params.get('error'))}
      footer={<BrokerButtons next={resolveNext(params.get('next'))} />}
      onSubmit={async ({ email, password }) => {
        try {
          await workspaceApi.signIn({ email, password });
        } catch (err) {
          if (err instanceof UnauthorizedError) {
            throw new Error('Invalid email or password');
          }
          throw err;
        }
        await refresh();
        navigate(resolveNext(params.get('next')), { replace: true });
      }}
    />
  );
}
