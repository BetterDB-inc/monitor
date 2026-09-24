import { ReactElement, useRef, useState } from 'react';
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
  const [copyFailed, setCopyFailed] = useState(false);
  const [trackedUrl, setTrackedUrl] = useState(url);
  const inputRef = useRef<HTMLInputElement | null>(null);

  if (url !== trackedUrl) {
    setTrackedUrl(url);
    setCopied(false);
    setCopyFailed(false);
  }

  const copy = async (): Promise<void> => {
    if (url === null) {
      return;
    }
    if (navigator.clipboard === undefined) {
      inputRef.current?.select();
      setCopyFailed(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      inputRef.current?.select();
      setCopyFailed(true);
    }
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
        <Input ref={inputRef} aria-label="Invite link" readOnly value={url ?? ''} />
        {copyFailed === true && (
          <p className="text-sm text-destructive">
            Copy failed. Select the link and copy it manually.
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            onClick={() => {
              void copy();
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
