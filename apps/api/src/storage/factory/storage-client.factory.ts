import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { PostgresAdapter } from '../adapters/postgres.adapter';
import { MemoryAdapter } from '../adapters/memory.adapter';

@Injectable()
export class StorageClientFactory {
  constructor(private configService: ConfigService) {}

  async createStorageClient(): Promise<StoragePort> {
    const storageType = this.configService.get<string>('STORAGE_TYPE', 'memory');

    let client: StoragePort;

    switch (storageType.toLowerCase()) {
      case 'sqlite': {
        const { SqliteAdapter } = await import('../adapters/sqlite.adapter');
        const filepath = this.configService.get<string>(
          'STORAGE_SQLITE_FILEPATH',
          './data/audit.db',
        );
        client = new SqliteAdapter({ filepath });
        break;
      }
      case 'turso': {
        const url = this.configService.get<string>('STORAGE_URL');
        if (!url) {
          throw new Error('STORAGE_URL is required for Turso storage');
        }
        const { SqliteAdapter } = await import('../adapters/sqlite.adapter');
        const authToken = this.configService.get<string>('STORAGE_AUTH_TOKEN');
        client = new SqliteAdapter({ url, authToken });
        break;
      }
      case 'postgres':
      case 'postgresql': {
        const connectionString = this.configService.get<string>('STORAGE_URL');
        if (!connectionString) {
          throw new Error('STORAGE_URL is required for PostgreSQL storage');
        }
        const schema = this.configService.get<string>('DB_SCHEMA');
        client = new PostgresAdapter({ connectionString, schema });
        break;
      }
      case 'memory':
      default: {
        client = new MemoryAdapter();
        break;
      }
    }

    await client.initialize();
    return client;
  }
}
