import { Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from '@thallesp/nestjs-better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { errorMessage } from '../common/errors';
import { requireWebAppOrigin } from '../common/web-app-origin';
import { PrismaService } from '../prisma/prisma.service';
import type { AppAuth } from './auth.config';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../generated/prisma/client';
import {
  HANDOFF_RETURN_PARAM,
  buildAppErrorUrl,
  buildAppHandoffUrl,
  buildAppLinkErrorUrl,
  buildApiHandoffCallbackUrl,
  resolveReturnOrigin,
  sanitizeNextPath,
} from './oauth-handoff';
import { buildTrustedOrigins } from './trusted-origins';
import { resolveSecurityPosture } from '../common/security-posture';

/**
 * Google sign-in for a web client that lives on a different SITE to this API.
 *
 * ## Why these routes exist at all
 *
 * Better Auth's own `/sign-in/social` is a POST, which a SPA reaches with
 * `fetch`. On a same-origin deployment — the shape it is designed for — that is
 * fine. Here it is fatal, because the OAuth state cookie it sets must then make
 * a journey no browser will allow it to complete:
 *
 *   - it is WRITTEN on a cross-origin `fetch` from `lopay.netlify.app`, so the
 *     browser files it as a third-party cookie belonging to that top-level site;
 *   - it is READ during the callback, which is a top-level navigation where
 *     THIS API is the top-level site.
 *
 * Those are two different jars. Safari's ITP refuses the write outright,
 * Firefox's Total Cookie Protection partitions it where the callback will never
 * look, and Chrome only appeared to work because it still allows unpartitioned
 * third-party cookies — which is why the failure reproduced in Safari and
 * Firefox but not in a default Chrome window, and why production has never once
 * recorded a `google` row in `Account`. Adding `Partitioned` (CHIPS) makes this
 * strictly worse: partitioning is the thing that separates the two jars.
 *
 * The fix is to stop asking a cookie to cross a site boundary. Starting the
 * flow as a TOP-LEVEL NAVIGATION to this API makes the state cookie first-party
 * on both the write and the read, so Better Auth's CSRF check on it keeps
 * working exactly as designed — nothing is skipped or relaxed. The session is
 * then handed back to the SPA as a one-time token in a URL fragment rather than
 * as a cookie. See `oauth-handoff.ts` for the hop-by-hop walk.
 *
 * ## Why they are `@Public()` and take no body
 *
 * Every route here is reached by a browser REDIRECT, not by the SPA's HTTP
 * client, so there is no `Authorization` header to carry and no JSON to post.
 * `/start` is genuinely unauthenticated — it is the beginning of a sign-in.
 * `/finish` is authenticated by the session cookie Better Auth has just written
 * on this origin. `/link/start` is authenticated by a one-time token the SPA
 * mints with its own bearer credential, because a top-level navigation cannot
 * carry one.
 *
 * ## Why every failure lands in the app
 *
 * `errorCallbackURL` is always an app URL. Left unset, Better Auth redirects to
 * `${baseURL}/api/auth/error` — this API's own bare error page, on a domain the
 * parent has never seen, with no route back into the product. That dead end is
 * half of the reported bug; the other half was the app not reading the `?error=`
 * it was handed.
 */
@ApiExcludeController()
@Controller('auth/google')
export class OAuthHandoffController {
  private readonly logger = new Logger(OAuthHandoffController.name);

  constructor(
    // Typed against THIS app's auth instance, not the package default: the
    // package's fallback generic describes a stock Better Auth, which knows
    // nothing of the `oneTimeToken` plugin registered in `auth.config.ts`.
    private readonly auth: AuthService<AppAuth>,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Begin a Google sign-in.
   *
   * The SPA sends the whole browser here rather than calling anything, which is
   * the entire point: the `Set-Cookie` below is first-party.
   *
   * Throttled per client IP like the rest of the auth surface. It is cheap —
   * one row in `verification` and one redirect — but it is unauthenticated and
   * mints state, so it does not get to be unbounded.
   */
  @Get('start')
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async start(
    @Query('next') next: string | undefined,
    @Query(HANDOFF_RETURN_PARAM) returnTo: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // Which client started this. The web build is the overwhelming case and the
    // fallback; the Capacitor shells name their own origin so a native sign-in
    // returns to the app rather than dropping the user on the Netlify site.
    const webOrigin = this.returnOrigin(returnTo);
    const safeNext = sanitizeNextPath(next);

    try {
      const { headers, response } = await this.auth.api.signInSocial({
        body: {
          provider: 'google',
          // Back to THIS origin, not the app's — see the class note. This is
          // the single line that keeps the session cookie first-party.
          callbackURL: buildApiHandoffCallbackUrl(
            this.apiOrigin(),
            safeNext,
            webOrigin,
          ),
          // Where the redirect half sends a failure. Better Auth appends
          // `?error=<code>` itself (`redirectOnError`), choosing `?` or `&`
          // correctly, so this must be handed over WITHOUT a query of its own.
          errorCallbackURL: `${webOrigin}/#/auth`,
        },
        returnHeaders: true,
      });

      // The OAuth state cookie. It has to reach the browser or the callback
      // has nothing to check against, and `returnHeaders` is the only way to
      // get it out of Better Auth when calling the API directly rather than
      // through its HTTP handler.
      OAuthHandoffController.forwardCookies(headers, res);

      const url = (response as { url?: string } | null)?.url;
      if (!url) {
        // Reachable when Google is not configured at all
        // (`CLIENT_ID_AND_SECRET_REQUIRED`): Better Auth resolves rather than
        // throws in some paths, and a blank redirect would hang the browser on
        // an empty page.
        this.logger.error('Google sign-in produced no redirect URL');
        res.redirect(buildAppErrorUrl(webOrigin, 'google_unavailable'));
        return;
      }

      res.redirect(url);
    } catch (error) {
      this.logger.error(
        `Could not start Google sign-in: ${errorMessage(error)}`,
      );
      res.redirect(buildAppErrorUrl(webOrigin, 'google_unavailable'));
    }
  }

  /**
   * Land the completed callback and hand the session to the web client.
   *
   * Reached only by Better Auth's own redirect, on this origin, with the
   * session cookie it has just set — which is why `generateOneTimeToken` can
   * authenticate from `req.headers` alone.
   */
  @Get('finish')
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async finish(
    @Query('next') next: string | undefined,
    @Query(HANDOFF_RETURN_PARAM) returnTo: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Re-validated rather than trusted: this URL has been to Google and back,
    // so by the time it returns it is caller-controlled like any other input.
    const webOrigin = this.returnOrigin(returnTo);
    const safeNext = sanitizeNextPath(next);

    let token: string;
    let userId: string | undefined;
    try {
      const headers = fromNodeHeaders(req.headers);
      const session = await this.auth.api.getSession({ headers });
      userId = session?.user?.id;

      const minted = await this.auth.api.generateOneTimeToken({ headers });
      if (!minted?.token) throw new Error('No handoff token was minted');
      token = minted.token;
    } catch (error) {
      // No session here means the callback did not actually sign anyone in.
      // Sending the visitor back to the form with a code they can act on beats
      // dropping them on a dashboard that will bounce them to `/welcome`.
      this.logger.warn(
        `Google callback reached the handoff without a session: ${errorMessage(error)}`,
      );
      res.redirect(buildAppErrorUrl(webOrigin, 'session_not_found'));
      return;
    }

    // Best-effort, and deliberately after the token is in hand: a failure to
    // warn must never cost a parent their sign-in.
    if (userId) await this.announceFirstGoogleLink(userId);

    res.redirect(buildAppHandoffUrl(webOrigin, token, safeNext));
  }

  /**
   * Begin attaching Google to the account that is ALREADY signed in.
   *
   * Same cookie problem, same shape of answer, one extra difficulty: a
   * top-level navigation carries no `Authorization` header, and this API's
   * session cookie is third-party to the SPA, so the browser arrives here
   * anonymous. The SPA therefore mints a one-time token with the bearer
   * credential it already holds and passes it in the query string.
   *
   * A query string is acceptable for this one value where it would not be for
   * the claim token in `enrollment-invites/claim-url.ts`: it is single-use,
   * expires in three minutes, is stored hashed, and is consumed microseconds
   * later by the line below — so the copy left in this API's own access log is
   * spent before the log is written.
   */
  @Get('link/start')
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async linkStart(
    @Query('ticket') ticket: string | undefined,
    @Query(HANDOFF_RETURN_PARAM) returnTo: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // Which client to return to, for the same reason `start` takes one: the
    // Capacitor shells must land back in the app rather than on the web build.
    const webOrigin = this.returnOrigin(returnTo);

    if (!ticket) {
      res.redirect(buildAppLinkErrorUrl(webOrigin, 'unable_to_link_account'));
      return;
    }

    try {
      // Consumes the ticket and returns the session behind it. This is the
      // proof of ownership that `/link-social` requires, recovered on an origin
      // where the SPA could not have sent one.
      const verified = await this.auth.api.verifyOneTimeToken({
        body: { token: ticket },
      });
      const sessionToken = verified?.session?.token;
      if (!sessionToken) throw new Error('Handoff ticket carried no session');

      // Replayed as a bearer credential rather than a cookie: the `bearer`
      // plugin turns it back into a session cookie internally, which is exactly
      // what `/link-social` reads, and it avoids hand-rolling a signed cookie.
      const { headers, response } = await this.auth.api.linkSocialAccount({
        body: {
          provider: 'google',
          callbackURL: `${webOrigin}/#/profile`,
          errorCallbackURL: `${webOrigin}/#/profile`,
        },
        headers: new Headers({ authorization: `Bearer ${sessionToken}` }),
        returnHeaders: true,
      });

      OAuthHandoffController.forwardCookies(headers, res);

      const url = (response as { url?: string } | null)?.url;
      if (!url) throw new Error('Link produced no redirect URL');

      res.redirect(url);
    } catch (error) {
      this.logger.error(
        `Could not start Google account link: ${errorMessage(error)}`,
      );
      res.redirect(buildAppLinkErrorUrl(webOrigin, 'unable_to_link_account'));
    }
  }

  // =============================== internals ===============================

  /**
   * Warn the owner the first time Google is attached to an account that already
   * had a password, and cut off any session that predates it.
   *
   * ## Why this exists
   *
   * `accountLinking.requireLocalEmailVerified` is false (see `auth.config.ts`),
   * which is what makes "Continue with Google" work for the parents who already
   * signed up with a password. The cost is that a password on this platform
   * proves nothing about the mailbox — nothing is ever verified — so somebody
   * who registers a victim's address first and waits has their password merged
   * into the victim's account the moment the victim arrives via Google.
   *
   * This does not close that. Only verifying email does, and there is no mail
   * provider. What it does is take away the half an attacker gets for free:
   * a session they were already sitting in. Every session older than this one
   * is revoked, so an attacker holding one is logged out rather than left
   * side-by-side with the owner, and the owner is told plainly that a Google
   * account was connected — which is the signal that lets them act at all.
   *
   * ## Why it is scoped this narrowly
   *
   * Revoking on EVERY Google sign-in would sign a parent out of their phone
   * whenever they signed in on a laptop, which is hostile and would train
   * people to ignore the notification. So it fires only when both are true:
   * the account carries a `credential` row (a password existed before), and
   * the Google row was created within the last few minutes (this sign-in linked
   * it). A parent who signed up THROUGH Google has no credential row and never
   * sees it; a returning Google user has an old `Account` row and never sees it.
   */
  private async announceFirstGoogleLink(userId: string): Promise<void> {
    try {
      const accounts = await this.prisma.account.findMany({
        where: { userId },
        select: { providerId: true, createdAt: true },
      });

      const google = accounts.find((a) => a.providerId === 'google');
      const hasPassword = accounts.some((a) => a.providerId === 'credential');
      if (!google || !hasPassword) return;

      const linkedJustNow =
        Date.now() - google.createdAt.getTime() < FRESH_LINK_WINDOW_MS;
      if (!linkedJustNow) return;

      // Ordered before the notification: if only one of the two can happen, the
      // one that removes an attacker's access is worth more than the one that
      // describes it.
      const { count } = await this.prisma.session.deleteMany({
        where: { userId, createdAt: { lt: google.createdAt } },
      });

      await this.notifications.create({
        userId,
        title: 'Google was connected to your account',
        message:
          'You can now sign in to Lopay with Google. ' +
          (count > 0
            ? 'For your security, you have been signed out everywhere else. '
            : '') +
          'If you did not do this, change your password and contact Lopay straight away.',
        type: NotificationType.ALERT,
        link: '/profile',
      });
    } catch (error) {
      this.logger.error(
        `Could not finalise Google link for ${userId}: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Copy Better Auth's `Set-Cookie` headers onto the Express response.
   *
   * `append`, never `set`: a single response can legitimately carry more than
   * one cookie, and overwriting would silently drop all but the last — which,
   * for the OAuth state cookie, means a callback that can never verify.
   */
  private static forwardCookies(headers: Headers, res: Response): void {
    for (const cookie of headers.getSetCookie()) {
      res.append('Set-Cookie', cookie);
    }
  }

  /** This API's own origin — the one Google redirects back to. */
  private apiOrigin(): string {
    return this.config.get<string>('BETTER_AUTH_URL') ?? '';
  }

  /**
   * The origin to return the finished sign-in to.
   *
   * Validated against the same `trustedOrigins` list Better Auth uses for
   * `callbackURL` on these very flows, so the two cannot drift apart — drift
   * being the thing that turns a return parameter into an open redirect. See
   * `resolveReturnOrigin`.
   */
  private returnOrigin(requested: string | undefined): string {
    const fallback = this.webAppOrigin();
    const posture = resolveSecurityPosture(process.env);
    const trusted = buildTrustedOrigins({
      corsOrigins: this.config.get<string>('CORS_ORIGINS'),
      betterAuthUrl: this.config.get<string>('BETTER_AUTH_URL'),
      httpsDeployment: posture.httpsDeployment,
    });
    return resolveReturnOrigin(requested, trusted, fallback);
  }

  /** Where the web client lives, or a thrown error naming the variable to set. */
  private webAppOrigin(): string {
    return requireWebAppOrigin(this.config, (candidate) =>
      this.logger.error(`Unparseable web app origin "${candidate}"`),
    );
  }
}

/**
 * How recently the Google row must have appeared to count as "linked by this
 * sign-in". Generous enough to absorb a slow consent screen and clock skew,
 * short enough that a returning user never trips it.
 */
const FRESH_LINK_WINDOW_MS = 5 * 60 * 1000;
