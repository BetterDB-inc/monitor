import { Module, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageClientFactory } from './factory/storage-client.factory';
import { StoragePort } from '../common/interfaces/storage-port.interface';

@Module({
  imports: [ConfigModule],
  providers: [
    StorageClientFactory,
    {
      provide: 'STORAGE_CLIENT',
      useFactory: async (factory: StorageClientFactory): Promise<StoragePort> => {
        return factory.createStorageClient();
      },
      inject: [StorageClientFactory],
    },
  ],
  exports: ['STORAGE_CLIENT'],
})
export class StorageModule implements OnModuleDestroy {
  constructor(@Inject('STORAGE_CLIENT') private readonly storageClient: StoragePort) {}

  async onModuleDestroy(): Promise<void> {
    await this.storageClient.close();
  }
}
