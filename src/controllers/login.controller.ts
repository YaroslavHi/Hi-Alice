/**
 * @module controllers/login.controller
 *
 * Standalone HI login page — used when HI_LOGIN_URL is set to /login on this service.
 *
 * Integrates with the OAuth 2.0 authorize flow:
 *   GET  /login  — render login form (HTML)
 *   POST /login  — verify credentials, redirect to /oauth/callback
 *
 * Query params passed by /oauth/authorize:
 *   redirect_back    — URL to redirect to after auth ({SERVICE_BASE_URL}/oauth/callback)
 *   yandex_redirect  — Yandex broker redirect URI (passed through)
 *   yandex_state     — Yandex OAuth state (passed through)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { verifyHouseCredentials } from '../services/house.service.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const loginQuerySchema = z.object({
  redirect_back:   z.string().url(),
  yandex_redirect: z.string().url(),
  yandex_state:    z.string().default(''),
});

const loginFormSchema = z.object({
  login:           z.string().min(1),
  password:        z.string().min(1),
  redirect_back:   z.string().url(),
  yandex_redirect: z.string().url(),
  yandex_state:    z.string().default(''),
});

// ─── HTML ─────────────────────────────────────────────────────────────────────

function renderLoginPage(params: {
  redirectBack:   string;
  yandexRedirect: string;
  yandexState:    string;
  error?:         string;
}): string {
  const errorHtml = params.error
    ? `<p class="error">${escapeHtml(params.error)}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>HI SmartBox — Вход</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #f5f5f5; display: flex; align-items: center;
           justify-content: center; min-height: 100vh }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 16px rgba(0,0,0,.1);
            padding: 40px; width: 100%; max-width: 400px }
    h1 { font-size: 22px; margin-bottom: 8px; color: #1a1a1a }
    p.sub { font-size: 14px; color: #666; margin-bottom: 28px }
    label { display: block; font-size: 13px; font-weight: 600; color: #333;
            margin-bottom: 4px; margin-top: 16px }
    input[type=text], input[type=password] {
      width: 100%; padding: 10px 14px; border: 1px solid #ccc;
      border-radius: 8px; font-size: 15px; outline: none }
    input:focus { border-color: #0a84ff; box-shadow: 0 0 0 2px rgba(10,132,255,.2) }
    .error { color: #d0021b; background: #fff2f2; border: 1px solid #ffd0d0;
             border-radius: 8px; padding: 10px 14px; margin-top: 16px; font-size: 14px }
    button { width: 100%; margin-top: 24px; padding: 12px; border: none;
             border-radius: 8px; background: #0a84ff; color: #fff;
             font-size: 16px; font-weight: 600; cursor: pointer }
    button:hover { background: #0071e3 }
  </style>
</head>
<body>
  <div class="card">
    <h1>Подключение SmartBox</h1>
    <p class="sub">Введите логин и пароль вашего контроллера HI SmartBox</p>
    ${errorHtml}
    <form method="POST" action="/login">
      <input type="hidden" name="redirect_back"   value="${escapeHtml(params.redirectBack)}">
      <input type="hidden" name="yandex_redirect" value="${escapeHtml(params.yandexRedirect)}">
      <input type="hidden" name="yandex_state"    value="${escapeHtml(params.yandexState)}">
      <label for="login">Логин</label>
      <input id="login" type="text" name="login" autocomplete="username" required>
      <label for="password">Пароль</label>
      <input id="password" type="password" name="password" autocomplete="current-password" required>
      <button type="submit">Войти</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleGetLogin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const r = loginQuerySchema.safeParse(req.query);
  if (!r.success) {
    return reply.code(400).send('Неверные параметры запроса');
  }
  const html = renderLoginPage({
    redirectBack:   r.data.redirect_back,
    yandexRedirect: r.data.yandex_redirect,
    yandexState:    r.data.yandex_state,
  });
  return reply.code(200).header('Content-Type', 'text/html; charset=utf-8').send(html);
}

async function handlePostLogin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const r = loginFormSchema.safeParse(req.body);
  if (!r.success) {
    return reply.code(400).send('Неверные параметры формы');
  }

  const house = await verifyHouseCredentials(req.server.pg, r.data.login, r.data.password);

  if (!house) {
    const html = renderLoginPage({
      redirectBack:   r.data.redirect_back,
      yandexRedirect: r.data.yandex_redirect,
      yandexState:    r.data.yandex_state,
      error:          'Неверный логин или пароль',
    });
    req.log.warn({ login: r.data.login }, 'Login failed — invalid credentials');
    return reply.code(401).header('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  if (!house.active) {
    const html = renderLoginPage({
      redirectBack:   r.data.redirect_back,
      yandexRedirect: r.data.yandex_redirect,
      yandexState:    r.data.yandex_state,
      error:          'Контроллер отключён. Обратитесь в поддержку.',
    });
    return reply.code(403).header('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  // Build callback URL — oauth.controller expects these params.
  const callbackUrl = new URL(r.data.redirect_back);
  callbackUrl.searchParams.set('hi_user_id',          house.ownerLogin);
  callbackUrl.searchParams.set('hi_house_id',          house.houseId);
  callbackUrl.searchParams.set('yandex_user_id',       house.houseId);  // stable per-house identifier
  callbackUrl.searchParams.set('yandex_state',         r.data.yandex_state);
  callbackUrl.searchParams.set('yandex_redirect_uri',  r.data.yandex_redirect);

  req.log.info({ houseId: house.houseId, login: r.data.login }, 'Login successful → redirect to OAuth callback');
  return reply.redirect(302, callbackUrl.toString());
}

// ─── Registration ─────────────────────────────────────────────────────────────

export async function registerLoginRoutes(app: FastifyInstance): Promise<void> {
  app.get('/login',  handleGetLogin);
  app.post('/login', handlePostLogin);
}
