import { ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { workspaceApi } from '../api/workspace';
import { useAuth } from '../contexts/AuthContext';
import { BrokerButtons } from '../components/auth/BrokerButtons';
import { brokerErrorMessage } from '../components/auth/broker-errors';
import { CredentialsForm } from '../components/auth/CredentialsForm';

export function Register(): ReactElement {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { refresh } = useAuth();

  return (
    <CredentialsForm
      title="Create the owner account"
      submitLabel="Create account"
      askName
      hint={
        <>
          Not running a team?
          <br />
          Set{' '}
          <code className="font-mono text-foreground">WORKSPACE_DISABLED=true</code>{' '}
          to skip sign-in entirely and open the dashboard to anyone with this
          URL.
        </>
      }
      notice={brokerErrorMessage(params.get('error'))}
      footer={<BrokerButtons />}
      onSubmit={async ({ email, password, name }) => {
        try {
          await workspaceApi.signUp({ email, password, name });
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) {
            await refresh();
          }
          throw error;
        }
        await refresh();
        navigate('/', { replace: true });
      }}
    />
  );
}
