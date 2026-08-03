import { EventsGateway } from './events.gateway';

describe('EventsGateway', () => {
  let gateway: EventsGateway;
  let authService: { api: { getSession: jest.Mock } };
  let server: { to: jest.Mock };
  let emit: jest.Mock;

  const makeClient = (handshake: Record<string, unknown> = {}) => ({
    id: 'sock1',
    handshake: { auth: {}, headers: {}, query: {}, ...handshake },
    disconnect: jest.fn(),
    join: jest.fn().mockResolvedValue(undefined),
    data: {} as Record<string, unknown>,
  });

  beforeEach(() => {
    authService = { api: { getSession: jest.fn() } };
    gateway = new EventsGateway(authService as never);
    emit = jest.fn();
    server = { to: jest.fn().mockReturnValue({ emit }) };
    (gateway as unknown as { server: unknown }).server = server;
  });

  describe('handleConnection', () => {
    it('disconnects a socket with no token before touching the session', async () => {
      const client = makeClient();
      await gateway.handleConnection(client as never);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(authService.api.getSession).not.toHaveBeenCalled();
    });

    it('disconnects when the session is invalid', async () => {
      authService.api.getSession.mockResolvedValue(null);
      const client = makeClient({ auth: { token: 'Bearer tok' } });
      await gateway.handleConnection(client as never);
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('joins the user room and stamps identity for a parent', async () => {
      authService.api.getSession.mockResolvedValue({
        user: { id: 'u1', role: 'PARENT', schoolId: null },
      });
      const client = makeClient({ auth: { token: 'tok' } });
      await gateway.handleConnection(client as never);
      expect(client.join).toHaveBeenCalledWith('user:u1');
      expect(client.join).not.toHaveBeenCalledWith('admins');
      expect(client.data).toEqual({
        userId: 'u1',
        role: 'PARENT',
        schoolId: null,
      });
    });

    it('also joins the school room for a school owner', async () => {
      authService.api.getSession.mockResolvedValue({
        user: { id: 'o1', role: 'SCHOOL_OWNER', schoolId: 's1' },
      });
      const client = makeClient({ auth: { token: 'tok' } });
      await gateway.handleConnection(client as never);
      expect(client.join).toHaveBeenCalledWith('user:o1');
      expect(client.join).toHaveBeenCalledWith('school:s1');
    });

    it('also joins the admins room for a super admin', async () => {
      authService.api.getSession.mockResolvedValue({
        user: { id: 'a1', role: 'SUPER_ADMIN', schoolId: null },
      });
      const client = makeClient({ auth: { token: 'tok' } });
      await gateway.handleConnection(client as never);
      expect(client.join).toHaveBeenCalledWith('admins');
    });

    it('defaults role to PARENT and schoolId to null when the session omits them', async () => {
      authService.api.getSession.mockResolvedValue({ user: { id: 'u2' } });
      const client = makeClient({ auth: { token: 'tok' } });
      await gateway.handleConnection(client as never);
      expect(client.data).toEqual({
        userId: 'u2',
        role: 'PARENT',
        schoolId: null,
      });
    });

    it('disconnects when the session lookup throws', async () => {
      authService.api.getSession.mockRejectedValue(new Error('boom'));
      const client = makeClient({ auth: { token: 'tok' } });
      await gateway.handleConnection(client as never);
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('reads a bearer token from the Authorization header', async () => {
      authService.api.getSession.mockResolvedValue({ user: { id: 'u1' } });
      const client = makeClient({ headers: { authorization: 'Bearer h-tok' } });
      await gateway.handleConnection(client as never);
      const headers = authService.api.getSession.mock.calls[0][0]
        .headers as Headers;
      expect(headers.get('authorization')).toBe('Bearer h-tok');
    });

    it('reads a token from the query string as a last resort', async () => {
      authService.api.getSession.mockResolvedValue({ user: { id: 'u1' } });
      const client = makeClient({ query: { token: 'q-tok' } });
      await gateway.handleConnection(client as never);
      expect(authService.api.getSession).toHaveBeenCalledTimes(1);
    });

    // Cookie auth mode (M2 dual-path). A cookie-mode client has no bearer token to
    // put in the handshake — it relies on the browser attaching the httpOnly
    // session cookie. Without this branch the HTTP layer would authenticate fine
    // while every socket was rejected for a "missing token", silently killing
    // realtime for the whole web app.
    describe('cookie session (no bearer token)', () => {
      it('authenticates from the handshake cookie', async () => {
        authService.api.getSession.mockResolvedValue({
          user: { id: 'u1', role: 'PARENT', schoolId: null },
        });
        const client = makeClient({
          headers: { cookie: 'better-auth.session_token=abc123' },
        });

        await gateway.handleConnection(client as never);

        const headers = authService.api.getSession.mock.calls[0][0]
          .headers as Headers;
        expect(headers.get('cookie')).toBe('better-auth.session_token=abc123');
        expect(client.join).toHaveBeenCalledWith('user:u1');
        expect(client.disconnect).not.toHaveBeenCalled();
      });

      it('still rejects an invalid cookie session', async () => {
        authService.api.getSession.mockResolvedValue(null);
        const client = makeClient({
          headers: { cookie: 'better-auth.session_token=stale' },
        });

        await gateway.handleConnection(client as never);

        expect(client.disconnect).toHaveBeenCalledWith(true);
      });

      it('prefers an explicit bearer token over the ambient cookie', async () => {
        authService.api.getSession.mockResolvedValue({ user: { id: 'u1' } });
        const client = makeClient({
          auth: { token: 'tok' },
          headers: { cookie: 'better-auth.session_token=abc123' },
        });

        await gateway.handleConnection(client as never);

        const headers = authService.api.getSession.mock.calls[0][0]
          .headers as Headers;
        expect(headers.get('authorization')).toBe('Bearer tok');
        expect(headers.get('cookie')).toBeNull();
      });

      it('rejects a handshake with neither credential without hitting the session', async () => {
        const client = makeClient({ headers: {} });

        await gateway.handleConnection(client as never);

        expect(authService.api.getSession).not.toHaveBeenCalled();
        expect(client.disconnect).toHaveBeenCalledWith(true);
      });
    });
  });

  it('handleDisconnect logs without throwing', () => {
    expect(() => gateway.handleDisconnect(makeClient() as never)).not.toThrow();
  });

  describe('emit API', () => {
    it('pushNotification is a no-op for a null user id', () => {
      gateway.pushNotification(null, { hi: 1 });
      expect(server.to).not.toHaveBeenCalled();
    });

    it('pushNotification emits a notification envelope to the user room', () => {
      gateway.pushNotification('u1', { hi: 1 });
      expect(server.to).toHaveBeenCalledWith('user:u1');
      expect(emit).toHaveBeenCalledWith('realtime', {
        type: 'notification',
        payload: { hi: 1 },
      });
    });

    it('emitPaymentsChanged fans out to parent, school and admin rooms', () => {
      gateway.emitPaymentsChanged({
        parentUserId: 'u1',
        schoolId: 's1',
        notifyAdmins: true,
      });
      expect(server.to).toHaveBeenCalledWith('user:u1');
      expect(server.to).toHaveBeenCalledWith('school:s1');
      expect(server.to).toHaveBeenCalledWith('admins');
      expect(emit).toHaveBeenCalledWith('realtime', {
        type: 'payments:changed',
      });
    });

    it('emitEnrollmentsChanged emits the enrollments:changed type', () => {
      gateway.emitEnrollmentsChanged({ schoolId: 's1' });
      expect(emit).toHaveBeenCalledWith('realtime', {
        type: 'enrollments:changed',
      });
    });

    it('emits nothing when a change has no targets', () => {
      gateway.emitPaymentsChanged({});
      expect(server.to).not.toHaveBeenCalled();
    });

    it('is a safe no-op when the server has not initialised yet', () => {
      (gateway as unknown as { server: unknown }).server = undefined;
      expect(() => gateway.pushNotification('u1', {})).not.toThrow();
    });
  });
});
