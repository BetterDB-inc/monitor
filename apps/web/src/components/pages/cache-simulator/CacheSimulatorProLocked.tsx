import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';

const PREVIEW = [
  { label: 'Dataset size', value: '18.4 GiB ± 0.3' },
  { label: 'Growth', value: '+42K keys/day' },
  { label: 'Reaches maxmemory', value: 'in ~37 days' },
  { label: 'Fits on', value: 'cache.r7g.xlarge' },
];

export function CacheSimulatorProLocked() {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-6">
          <p className="font-medium">Upgrade to Pro to size and project your cache</p>
          <p className="text-sm text-muted-foreground">
            Measure your real dataset size, see when you will hit maxmemory and which cloud node fits it.
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
              <CardTitle className="text-sm font-medium text-muted-foreground">{item.label}</CardTitle>
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
