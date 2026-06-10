import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions, Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';

/**
 * Socket.IO adapter that fans realtime events across instances via Redis pub/sub.
 *
 * Activated ONLY when REDIS_URL is set; otherwise this behaves exactly like the
 * default in-memory IoAdapter (correct for a single instance). Without it, a
 * client connected to instance A never receives events emitted from instance B —
 * so this must be connected before scaling beyond one node.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  /** Connect the pub/sub clients. Returns true if Redis was configured + reachable. */
  async connectToRedis(): Promise<boolean> {
    const url = process.env.REDIS_URL;
    if (!url) return false;

    const pubClient = createClient({ url });
    const subClient = pubClient.duplicate();
    pubClient.on('error', (e) => this.logger.error(`Redis pub error: ${e}`));
    subClient.on('error', (e) => this.logger.error(`Redis sub error: ${e}`));

    await Promise.all([pubClient.connect(), subClient.connect()]);
    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log('Socket.IO Redis adapter connected');
    return true;
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server: Server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
