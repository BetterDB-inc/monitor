import { FormEvent, ReactElement, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface CredentialsFormValues {
  email: string;
  password: string;
  name: string;
}

interface CredentialsFormProps {
  title: string;
  submitLabel: string;
  askName: boolean;
  onSubmit: (values: CredentialsFormValues) => Promise<void>;
}

export function CredentialsForm({
  title,
  submitLabel,
  askName,
  onSubmit,
}: CredentialsFormProps): ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ email, password, name });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-8">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {askName && (
          <Input
            aria-label="Name"
            placeholder="Name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            required
          />
        )}
        <Input
          aria-label="Email"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
          }}
          required
        />
        <Input
          aria-label="Password"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
          minLength={8}
          required
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy}>
          {submitLabel}
        </Button>
      </form>
    </div>
  );
}
