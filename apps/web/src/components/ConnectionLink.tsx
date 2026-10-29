import { Link, useLocation, type LinkProps } from 'react-router-dom';
import { CONNECTION_PARAM } from '../lib/connectionParam';

interface ConnectionLinkProps extends Omit<LinkProps, 'to'> {
  to: string;
}

export function ConnectionLink({ to, ...props }: ConnectionLinkProps) {
  const { search } = useLocation();
  const connectionId = new URLSearchParams(search).get(CONNECTION_PARAM);
  if (connectionId === null) {
    return <Link to={to} {...props} />;
  }
  const url = new URL(to, window.location.origin);
  url.searchParams.set(CONNECTION_PARAM, connectionId);
  return <Link to={{ pathname: url.pathname, search: url.search, hash: url.hash }} {...props} />;
}
