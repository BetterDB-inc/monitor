import { Injectable } from '@nestjs/common';

@Injectable()
export class BootstrapLock {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(() => {
      return task();
    });
    this.tail = pending.then(
      () => {
        return undefined;
      },
      () => {
        return undefined;
      },
    );
    return pending;
  }
}
