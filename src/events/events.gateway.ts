import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';

/** Decoded identity attached to every authenticated socket. */
interface AuthedSocketData {
  userId: string;
  role: string;
  schoolId: string | null;
}

type RealtimeEventType =
  | 'notification'
  | 'payments:changed'
  | 'enrollments:changed';

interface RealtimeEnvelope {
  type: RealtimeEventType;
  payload?: unknown;
}

/** Which rooms a "something changed" event should reach. */
export interface ChangeTargets {
  parentUserId?: string | null;
  schoolId?: string | null;
  notifyAdmins?: boolean;
}

/**
 * Single Socket.IO gateway for the whole platform.
 *
 * Auth: clients pass their backend JWT via `handshake.auth.token` (or an
 * Authorization header / `?token=` query as fallbacks). Unverified sockets are
 * disconnected immediately.
 *
 * Rooms: every socket joins `user:{userId}`; school owners also join
 * `school:{schoolId}`; super admins also join `admins`. Feature services emit
 * to these rooms via the public helpers below.
 */
@WebSocketGateway({
  cors: { origin: true, credentials: true },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);
      if (!token) {
        this.logger.warn(`Socket ${client.id} rejected: missing token`);
        client.disconnect(true);
        return;
      }

      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        role: string;
        schoolId?: string | null;
      }>(token);

      const data: AuthedSocketData = {
        userId: payload.sub,
        role: payload.role,
        schoolId: payload.schoolId ?? null,
      };
      client.data = data;

      client.join(this.userRoom(data.userId));
      if (data.schoolId) {
        client.join(this.schoolRoom(data.schoolId));
      }
      if (data.role === 'SUPER_ADMIN') {
        client.join('admins');
      }

      this.logger.log(
        `Socket ${client.id} connected (user=${data.userId}, role=${data.role}, school=${data.schoolId ?? '-'})`,
      );
    } catch (err) {
      this.logger.warn(
        `Socket ${client.id} rejected: ${(err as Error).message}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Socket ${client.id} disconnected`);
  }

  // --- Public emit API (called by feature services) ---

  /** Push a fresh notification to a single user's devices. */
  pushNotification(userId: string | null | undefined, notification: unknown) {
    if (!userId) return;
    this.emitTo(this.userRoom(userId), {
      type: 'notification',
      payload: notification,
    });
  }

  /** Signal that payment-related data changed for the given audiences. */
  emitPaymentsChanged(targets: ChangeTargets) {
    this.broadcastChange('payments:changed', targets);
  }

  /** Signal that enrollment-related data changed for the given audiences. */
  emitEnrollmentsChanged(targets: ChangeTargets) {
    this.broadcastChange('enrollments:changed', targets);
  }

  // --- Internals ---

  private broadcastChange(type: RealtimeEventType, targets: ChangeTargets) {
    const rooms = new Set<string>();
    if (targets.parentUserId) {
      rooms.add(this.userRoom(targets.parentUserId));
    }
    if (targets.schoolId) {
      rooms.add(this.schoolRoom(targets.schoolId));
    }
    if (targets.notifyAdmins) {
      rooms.add('admins');
    }
    for (const room of rooms) {
      this.emitTo(room, { type });
    }
  }

  private emitTo(room: string, envelope: RealtimeEnvelope) {
    // server is undefined only before the gateway has initialised; all real
    // emits happen in response to HTTP requests, long after startup.
    if (!this.server) return;
    this.server.to(room).emit('realtime', envelope);
  }

  private extractToken(client: Socket): string | null {
    const strip = (raw: string) => raw.replace(/^Bearer\s+/i, '').trim();

    const authToken = client.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken) return strip(authToken);

    const header = client.handshake.headers?.authorization;
    if (typeof header === 'string' && header) return strip(header);

    const queryToken = client.handshake.query?.token;
    if (typeof queryToken === 'string' && queryToken) return strip(queryToken);

    return null;
  }

  private userRoom(userId: string) {
    return `user:${userId}`;
  }

  private schoolRoom(schoolId: string) {
    return `school:${schoolId}`;
  }
}
