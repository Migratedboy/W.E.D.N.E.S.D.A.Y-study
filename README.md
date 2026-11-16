# W.E.D.N.E.S.D.A.Y STUDY

An AI study app: a chat tutor, quick actions (explain / quiz / summary / flashcards /
formulas), SM-2 spaced-repetition flashcards, streaks and XP, a leaderboard, YouTube
"AI Learning Resources", and a premium workspace.

Plain HTML/CSS/JS on the client and a single Node HTTP server — no build step, no framework.

---

## Quick start

```bash
# 1. Install the two runtime dependencies
npm install

# 2. Create a Supabase project, then run the schema
#    Supabase dashboard -> SQL Editor -> paste supabase_schema.sql -> Run

# 3. Configure the environment
cp .env.example .env
#    fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY

# 4. Start
npm start          # http://localhost:4174
```

Optional but recommended: `AI_API_KEY` (otherwise the tutor falls back to offline
replies), `GMAIL_USER` + `GMAIL_APP_PASSWORD` (otherwise verification codes print to
the server console), `YOUTUBE_API_KEY` (for AI Learning Resources).

### Why `npm start` exits immediately

The server refuses to boot without a database and tells you so:

```
[Supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set in .env - cannot start without a database.
```

Use the **service role** key, not the anon key. It bypasses Row Level Security and
must never be shipped to the browser.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run the server |
| `npm run dev` | Run with `--watch` (restarts on file change) |
| `npm test` | Run the whole test suite (`node --test`) |

There is no build step. `index.html` and `login.html` are served directly, with their
assets under `static/`.

---

## Layout

```
index.html            app shell (markup only, ~330 lines)
login.html            sign-in / sign-up / verify flow
server.js             HTTP server: routing, auth, AI plumbing
lib/
  scheduling.js       SM-2 review step, streak + XP rules  (pure, tested)
  entitlement.js      premium decision + rate-limit math   (pure, tested)
  auth.js             password hashing, session tokens     (pure, tested)
  text.js             model-output parsing, grading, budgets (pure, tested)
static/
  css/app.css         the UI's styles
  js/app.js           the UI's behaviour
  css/login.css
  js/login.js
supabase_schema.sql   database + storage setup (idempotent)
tests/                unit + integration tests
```

`/css/*` and `/js/*` are served from `static/`. Nothing else under the project root
is web-reachable — in particular `server.js`, `lib/`, `package.json` and `.env` are
not downloadable.

---

## Architecture notes

**The client is split but not bundled.** Browser-native `<script src>` only, so there
is nothing to build and nothing to break. If the app grows past this size, converting
`static/js/app.js` into native ES modules (`import`/`export`, still no bundler) is the
natural next step.

**Pure logic lives in `lib/`.** Anything with interesting rules — SM-2 intervals, XP
and streak maths, quiz grading, history budgeting — is a pure function with an
injectable clock, imported by both `server.js` and the tests. When you change a rule,
change it in one place and add a case to `tests/`.

**Premium is server-enforced.** Entitlement is the `users.is_premium` column, read
per request. The `x-dev-premium` header is honoured only when `NODE_ENV` is not
`production`, so the local UI toggle still works without being a production bypass.

**Quizzes are graded server-side.** `POST /api/quiz/start` generates the questions and
stores the answer key; `POST /api/quiz/complete` takes only an `attemptId` plus the
chosen option indices. The client never reports its own score, and an attempt can be
graded exactly once.

**Session tokens are stored hashed.** The cookie holds the raw token; the database
holds its SHA-256. A leaked database dump yields no usable sessions.

---

## Environment variables

See `.env.example` for the full annotated list. The ones that matter most:

| Variable | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service role key — server-side only |
| `AI_API_KEY` | no | Any OpenAI-compatible provider |
| `AI_API_BASE_URL` | no | Defaults to NVIDIA's NIM endpoint |
| `AI_MODELS` | no | Comma-separated fallback chain |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | no | Sends verification codes by email |
| `YOUTUBE_API_KEY` | no | AI Learning Resources |
| `PORT` | no | Default `4174` |
| `HOST` | no | Default `0.0.0.0`; use `127.0.0.1` to restrict to loopback |
| `NODE_ENV` | no | Set to `production` in deployment |
| `TRUST_PROXY` | no | Set to `1` only behind a proxy you control |

---

## Deploying

The server binds to `0.0.0.0` by default, so it works in Docker and on PaaS hosts.
In production, set at minimum:

```
NODE_ENV=production
FORCE_SECURE_COOKIE=1        # if TLS terminates at a proxy
ALLOWED_ORIGINS=https://your-domain.example
TRUST_PROXY=1                # only if you control the proxy
```

`NODE_ENV=production` hides provider error details from clients and disables the
dev premium header.

---

## Tests

```bash
npm test
```

- **Unit** (`tests/sm2`, `progress`, `auth`, `text`) — the pure rules.
- **Integration** (`tests/server.test.js`) — boots the real `server.js` against an
  in-memory mock of Supabase (`tests/helpers/mock-supabase.js`) and asserts the
  security properties that matter: static-file exposure, CSP delivery, premium
  enforcement, session hashing, and that forged quiz scores award no XP.

The integration tests do not touch the network or a real database.

---

## Conventions

- No build step, no bundler, no framework. Keep it that way unless there's a reason.
- Anything with a rule worth testing goes in `lib/` as a pure function.
- Never trust a client-supplied score, entitlement, or identity.
- `.env` is gitignored; `.env.example` is the contract. Add new variables there.
