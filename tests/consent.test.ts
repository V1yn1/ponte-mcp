import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const [script, html] = await Promise.all([
  readFile(new URL('../public/consent.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/consent.html', import.meta.url), 'utf8'),
]);
const pageUrl = new URL('https://ponte-test.ngrok-free.app/oauth/consent?request=request-demo');
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const interstitial = () => new Response('<!doctype html><html><body>Visit Site — ERR_NGROK_6024</body></html>', {
  status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' },
});
const pending = () => json({
  status: 'pending',
  request: {
    id: 'request-demo', verificationCode: 'A1B2C3D4', clientName: 'ChatGPT',
    redirectUri: 'https://chatgpt.com/connector_platform/oauth/callback',
    scopes: ['ponte:tools'], expiresAt: Math.floor(Date.now() / 1000) + 300,
  },
  adminUrl: 'http://127.0.0.1:4317',
});

type BrowserRequest = { url: URL; headers: Headers };
type Transport = (request: BrowserRequest) => Response | Promise<Response>;

// Execute the shipped script against the actual page's IDs. Only the DOM,
// browser timers and external transport are simulated; responses use Fetch APIs.
async function openConsent(transport: Transport, visitorCookie = true) {
  const elements = new Map([...html.matchAll(/<([a-z\d-]+)\b([^>]*\bid="([^"]+)"[^>]*)>([^<]*)/gi)].map(match => {
    const attributes = match[2];
    const classes = new Set(attributes.match(/\bclass="([^"]*)"/)?.[1].split(/\s+/) ?? []);
    return [match[3], {
      textContent: match[4].trim(),
      hidden: /(?:^|\s)hidden(?:\s|=|$)/.test(attributes),
      href: attributes.match(/\bhref="([^"]*)"/)?.[1] ?? '',
      dataset: { state: attributes.match(/\bdata-state="([^"]*)"/)?.[1] ?? '' },
      classList: {
        add: (name: string) => { classes.add(name); },
        remove: (name: string) => { classes.delete(name); },
        contains: (name: string) => classes.has(name),
      },
    }] as const;
  }));
  const element = (id: string) => {
    const found = elements.get(id);
    assert.ok(found, `Missing consent-page element: ${id}`);
    return found;
  };
  const redirects: string[] = [];
  const timers = new Map<number, { callback: () => unknown; delay: number }>();
  let timerId = 0;
  const location = {
    href: pageUrl.href, origin: pageUrl.origin, hostname: pageUrl.hostname,
    protocol: pageUrl.protocol, search: pageUrl.search,
    replace: (destination: string) => { redirects.push(destination); },
  };
  runInNewContext(script, {
    document: { querySelector: (selector: string) => element(selector.replace(/^#/, '')) },
    location,
    window: { addEventListener: () => {} },
    URL, URLSearchParams, Date, AbortController, Headers, Response,
    setTimeout: (callback: () => unknown, delay: number) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
    fetch: async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, pageUrl);
      if (url.pathname !== '/oauth/consent/status' || url.searchParams.get('request') !== 'request-demo') {
        return json({ error: 'not_found' }, 404);
      }
      const headers = new Headers(init.headers);
      // The browser has already accepted the tunnel's visitor interstitial.
      // Model cookie delivery, so a test cannot pass just by asserting fetch options.
      if (visitorCookie && (init.credentials === 'include' || (init.credentials !== 'omit' && url.origin === pageUrl.origin))) {
        headers.set('Cookie', 'tunnel-visitor=accepted');
      }
      return transport({ url, headers });
    },
  }, { filename: 'public/consent.js' });
  await settle();
  return {
    element, redirects,
    statusText: () => `${element('status-title').textContent} ${element('status-description').textContent}`,
    hasRetry: () => timers.size > 0,
    retry: async () => {
      const next = [...timers].sort(([, a], [, b]) => a.delay - b.delay)[0];
      assert.ok(next, 'A recoverable failure must schedule another attempt');
      timers.delete(next[0]);
      await next[1].callback();
      await settle();
    },
  };
}

test('consent uses an existing same-origin tunnel session and completes after approval', async () => {
  let approved = false;
  const page = await openConsent(({ headers }) => {
    if (headers.get('Cookie') !== 'tunnel-visitor=accepted') return interstitial();
    return approved ? json({ status: 'approved' }) : pending();
  });

  assert.equal(page.element('verification-code').textContent, 'A1B2C3D4');
  assert.equal(page.element('request-information').hidden, false);
  assert.equal(page.element('consent-status').dataset.state, 'pending');
  assert.deepEqual(page.redirects, []);

  approved = true;
  await page.retry();
  assert.deepEqual(page.redirects, ['/oauth/complete?request=request-demo']);
  assert.equal(page.hasRetry(), false);
});

test('consent gets past the ngrok browser warning without an existing visitor cookie', async () => {
  let approved = false;
  const page = await openConsent(({ headers }) => {
    assert.equal(headers.has('Cookie'), false, 'This flow must work before a visitor cookie exists');
    if (!headers.has('ngrok-skip-browser-warning')) return interstitial();
    return approved ? json({ status: 'approved' }) : pending();
  }, false);

  assert.equal(page.element('verification-code').textContent, 'A1B2C3D4');
  assert.equal(page.element('consent-status').dataset.state, 'pending');
  approved = true;
  await page.retry();
  assert.deepEqual(page.redirects, ['/oauth/complete?request=request-demo']);
  assert.equal(page.hasRetry(), false);
});

test('consent explains an HTML tunnel response, clears loading and recovers on retry', async () => {
  let tunnelReady = false;
  const page = await openConsent(() => tunnelReady ? pending() : interstitial());

  assert.match(page.statusText(), /HTML/i);
  assert.match(page.statusText(), /túnel|ngrok|intermediári/i);
  assert.notEqual(page.element('verification-code').textContent, 'Carregando…');
  assert.equal(page.element('verification-code').classList.contains('is-loading'), false);
  assert.deepEqual(page.redirects, []);

  tunnelReady = true;
  await page.retry();
  assert.equal(page.element('verification-code').textContent, 'A1B2C3D4');
  assert.equal(page.element('consent-status').dataset.state, 'pending');
  assert.equal(page.element('request-information').hidden, false);
});

test('consent reports an HTTP failure with its status and retries until the server recovers', async () => {
  let healthy = false;
  const page = await openConsent(() => healthy ? pending() : json({ error: 'unavailable' }, 503));

  assert.match(page.statusText(), /HTTP\s*503/i);
  assert.notEqual(page.element('verification-code').textContent, 'Carregando…');
  assert.deepEqual(page.redirects, []);
  healthy = true;
  await page.retry();
  assert.equal(page.element('verification-code').textContent, 'A1B2C3D4');
});

test('consent identifies a network failure without pretending the request is still loading', async () => {
  const page = await openConsent(() => { throw new TypeError('Failed to fetch'); });

  assert.match(page.statusText(), /rede|conexão|consultar/i);
  assert.doesNotMatch(page.statusText(), /HTTP\s*\d{3}/i);
  assert.notEqual(page.element('verification-code').textContent, 'Carregando…');
  assert.equal(page.element('verification-code').classList.contains('is-loading'), false);
  assert.equal(page.hasRetry(), true);
  assert.deepEqual(page.redirects, []);
});

for (const failure of [
  {
    name: 'malformed JSON', expected: /resposta inválida/i,
    response: () => new Response('{"status":', { headers: { 'Content-Type': 'application/json' } }),
  },
  {
    name: 'connection lost while reading the response', expected: /falha de rede/i,
    response: () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('connection reset: private-test-detail')); },
    }), { headers: { 'Content-Type': 'application/json' } }),
  },
]) {
  test(`consent distinguishes ${failure.name} and can recover after approval`, async () => {
    let healthy = false;
    const page = await openConsent(() => healthy ? json({ status: 'approved' }) : failure.response());

    assert.match(page.statusText(), failure.expected);
    assert.doesNotMatch(page.statusText(), /private-test-detail/);
    assert.deepEqual(page.redirects, []);
    healthy = true;
    await page.retry();
    assert.deepEqual(page.redirects, ['/oauth/complete?request=request-demo']);
    assert.equal(page.hasRetry(), false);
  });
}

for (const terminal of [
  { name: 'missing request', response: () => json({ error: 'not_found' }, 404), state: 'error' },
  { name: 'expired request', response: () => json({ status: 'expired' }), state: 'expired' },
]) {
  test(`consent stops polling a ${terminal.name} and offers a new connection`, async () => {
    const page = await openConsent(terminal.response);

    assert.equal(page.element('consent-status').dataset.state, terminal.state);
    assert.equal(page.element('terminal-help').hidden, false);
    assert.equal(page.element('open-dashboard').hidden, true);
    assert.notEqual(page.element('verification-code').textContent, 'Carregando…');
    assert.equal(page.element('verification-code').classList.contains('is-loading'), false);
    assert.equal(page.hasRetry(), false);
    assert.deepEqual(page.redirects, []);
  });
}

test('consent returns a rejected decision to the client and stops polling', async () => {
  const page = await openConsent(() => json({ status: 'rejected' }));

  assert.equal(page.element('consent-status').dataset.state, 'rejected');
  assert.deepEqual(page.redirects, ['/oauth/complete?request=request-demo']);
  assert.equal(page.hasRetry(), false);
});
