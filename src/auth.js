import crypto from 'crypto';
import passport from 'passport';
import GoogleStrategy from 'passport-google-oauth20';
import session from 'express-session';

const ALLOWED_DOMAIN = 'frostdesigngroup.com';
const ACCESS_DENIED_MSG = 'Access restricted to Frost Design Group accounts.';

const escapeHtml = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const loginPage = (basePath, error) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Osiris — Sign In</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #161616; border: 1px solid #2a2a2a; border-radius: 12px; padding: 48px; text-align: center; max-width: 380px; width: 100%; }
    h1 { font-size: 28px; font-weight: 600; letter-spacing: 2px; margin-bottom: 8px; }
    .sub { color: #888; font-size: 13px; margin-bottom: 32px; }
    .error { color: #e55; font-size: 13px; margin-bottom: 16px; }
    .btn { display: inline-flex; align-items: center; gap: 10px; background: #fff; color: #333; border: none; border-radius: 6px; padding: 12px 24px; font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; transition: background 0.15s; }
    .btn:hover { background: #eee; }
    .btn svg { width: 18px; height: 18px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>OSIRIS</h1>
    <p class="sub">Design Intelligence Platform</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <a href="${basePath}/auth/google" class="btn">
      <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
      Sign in with Google
    </a>
  </div>
</body>
</html>`;

export function setupAuth(router, basePath) {
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  passport.use(new GoogleStrategy.Strategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${basePath}/auth/google/callback`,
    proxy: true,
  }, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value;
    if (!email?.endsWith(`@${ALLOWED_DOMAIN}`)) {
      return done(null, false, { message: ACCESS_DENIED_MSG });
    }
    done(null, { email, name: profile.displayName, picture: profile.photos?.[0]?.value });
  }));

  router.use(session({
    secret: process.env.SESSION_SECRET || (() => { console.warn('WARNING: SESSION_SECRET not set — sessions will not persist across restarts'); return crypto.randomBytes(32).toString('hex'); })(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
    },
  }));
  router.use(passport.initialize());
  router.use(passport.session());

  // Auth routes
  router.get('/auth/login', (req, res) => {
    const error = req.query.error;
    res.send(loginPage(basePath, error));
  });

  router.get('/auth/google',
    passport.authenticate('google', { scope: ['email', 'profile'] })
  );

  router.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: `${basePath}/auth/login?error=${encodeURIComponent(ACCESS_DENIED_MSG)}` }),
    (req, res) => {
      const returnTo = req.session.returnTo || `${basePath}/frontend/`;
      delete req.session.returnTo;
      res.redirect(returnTo);
    }
  );

  router.get('/auth/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.redirect(`${basePath}/auth/login`);
    });
  });

  function requireAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    req.session.returnTo = req.originalUrl;
    res.redirect(`${basePath}/auth/login`);
  }

  return { requireAuth };
}
