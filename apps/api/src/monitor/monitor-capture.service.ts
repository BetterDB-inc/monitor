import { Inject, Injectable } from '@nestjs/common';
import {
  CaptureSessionQueryOptions,
  StoragePort,
  StoredCaptureSession,
} from '../common/interfaces/storage-port.interface';

@Injectable()
export class MonitorCaptureService {
  constructor(
    @Inject('STORAGE_CLIENT')
    private readonly storage: StoragePort,
  ) {}

  listSessions(options: CaptureSessionQueryOptions = {}): Promise<StoredCaptureSession[]> {
    return this.storage.getCaptureSessions(options);
  }
}
