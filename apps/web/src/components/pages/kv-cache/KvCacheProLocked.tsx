import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';

const PREVIEW = [
  { label: 'Hit rate', value: '62%' },
  { label: 'Cached chunks', value: '48,210' },
  { label: 'Footprint', value: '14.2 GiB' },
  { label: 'Memory share', value: '38%' },
];

export function KvCacheProLocked() {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-6">
          <p className="font-medium">Upgrade to Pro to monitor your LMCache KV cache</p>
          <p className="text-sm text-muted-foreground">
            See hit rate, footprint and eviction risk for the LMCache engines writing to this
            database.
          </p>
          <Link
            to="/settings?section=license"
            className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Upgrade
          </Link>
        </CardContent>
      </Card>
      <div aria-hidden="true" className="grid gap-4 opacity-50 sm:grid-cols-2 lg:grid-cols-4">
        {PREVIEW.map((item) => (
          <Card key={item.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {item.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{item.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
