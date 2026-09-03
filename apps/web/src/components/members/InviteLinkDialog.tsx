import { ReactElement, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

interface InviteLinkDialogProps {
  url: string | null;
  onClose: () => void;
}

export function InviteLinkDialog({ url, onClose }: InviteLinkDialogProps): ReactElement {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [url]);

  const copy = async (): Promise<void> => {
    if (url === null) {
      return;
    }
    await navigator.clipboard.writeText(url);
    setCopied(true);
  };

  return (
    <Dialog
      open={url !== null}
      onOpenChange={(open) => {
        if (open === false) {
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite link</DialogTitle>
          <DialogDescription>
            Share this link with the invitee. It works once and expires in 7 days. It is not shown
            again.
          </DialogDescription>
        </DialogHeader>
        <Input aria-label="Invite link" readOnly value={url ?? ''} />
        <DialogFooter>
          <Button
            type="button"
            onClick={() => {
              copy();
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
