import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { SqliteAdapter } from '../adapters/sqlite.adapter';

@Injectable()
export class StorageClientFactory {
  constructor(private configService: ConfigService) {}

  async createStorageClient(): Promise<StoragePort> {
    const storageType = this.configService.get<string>('storage.type', 'sqlite');

    let client: StoragePort;

    switch (storageType) {
      case 'sqlite': {
        const filepath = this.configService.get<string>(
          'storage.sqlite.filepath',
          './data/audit.db',
        );
        client = new SqliteAdapter({ filepath });
        break;
      }
      default:
        throw new Error(`Unsupported storage type: ${storageType}`);
    }

    await client.initialize();
    return client;
  }
}
