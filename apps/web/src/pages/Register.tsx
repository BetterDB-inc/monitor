import { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { workspaceApi } from '../api/workspace';
import { useAuth } from '../contexts/AuthContext';
import { CredentialsForm } from '../components/auth/CredentialsForm';

export function Register(): ReactElement {
  const navigate = useNavigate();
  const { refresh } = useAuth();

  return (
    <CredentialsForm
      title="Create the owner account"
      submitLabel="Create account"
      askName
      onSubmit={async ({ email, password, name }) => {
        await workspaceApi.signUp({ email, password, name });
        await refresh();
        navigate('/', { replace: true });
      }}
    />
  );
}
