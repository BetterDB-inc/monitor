import { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { workspaceApi } from '../api/workspace';
import { useAuth } from '../contexts/AuthContext';
import { BrokerButtons } from '../components/auth/BrokerButtons';
import { CredentialsForm } from '../components/auth/CredentialsForm';

export function Register(): ReactElement {
  const navigate = useNavigate();
  const { refresh } = useAuth();

  return (
    <CredentialsForm
      title="Create the owner account"
      submitLabel="Create account"
      askName
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
