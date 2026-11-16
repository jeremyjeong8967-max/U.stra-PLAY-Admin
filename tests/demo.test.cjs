// Dependency-free logic regression tests. DOM and storage are simulated; this is not a browser UI test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const adminFile = 'U.stra PLAY-Admin.html';
const gamesFile = 'U.stra PLAY-Games.html';
function source(file) {
  return [...fs.readFileSync(path.join(root, file), 'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).join('\n');
}
const event = {
  id: 'test-event', title: 'Test event', game: 0, status: 'active',
  start: '2026-01-01T00:00', end: '2026-12-31T23:59', config: { targetOrder: 1 },
};
const quiz = {
  ...event, game: 2,
  config: { quizQuestion: 'Choose A', quizOptions: 'A\nB', quizAnswer: 'A', quizSeconds: 30 },
};

function environment(file = gamesFile, { preview = false, registered = true, current = event } = {}) {
  const values = new Map();
  if (registered) values.set('gplay_events', JSON.stringify([current]));
  const elements = new Map();
  const timers = new Map();
  const options = [0, 1].map(index => ({ dataset: { option: String(index) }, classList: { add() {} } }));
  let now = Date.parse('2026-11-16T03:00:00Z');
  let timerId = 0;
  function element(id) {
    if (!elements.has(id)) {
      let html = '';
      const classes = new Set();
      const value = {
        id, value: '', disabled: false, textContent: '', firstChild: { textContent: '' }, style: {},
        classList: { add: key => classes.add(key), remove: key => classes.delete(key),
          contains: key => classes.has(key), toggle() {} },
        addEventListener() {}, setAttribute() {}, querySelectorAll: () => [],
        appendChild(child) { elements.set(child.id, child); },
        get innerHTML() { return html; },
        set innerHTML(text) {
          // Replacing quiz output removes its retry button, like the real DOM.
          if (id === 'quizResult') elements.delete('quizRetry');
          html = text;
          for (const match of text.matchAll(/\bid="([^"]+)"/g)) element(match[1]);
        },
      };
      elements.set(id, value);
    }
    return elements.get(id);
  }
  for (const id of ['gate','gateMessage','gameArea','playerName','employeeId','joinBtn',
    'eventTitle','gameName','eventPeriod','eventPrize','eventDesc','gateTitle','gateDesc','joinForm']) element(id);
  const storage = {
    get length() { return values.size; }, key: index => [...values.keys()][index],
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key),
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    console, URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, atob, btoa,
    structuredClone, Math, Promise, Date: Clock, localStorage: storage,
    location: {
      href: 'http://localhost:8765/' + encodeURIComponent(adminFile),
      search: preview ? '?preview=1' : '',
      hash: '#event=' + Buffer.from(JSON.stringify(current)).toString('base64url'),
    },
    crypto: { randomUUID }, navigator: { locks: { request: async (_, callback) => callback() } },
    document: {
      querySelector: element, querySelectorAll: selector => selector === '.option' ? options : [],
      getElementById: id => elements.get(id) ?? null,
      addEventListener() {}, body: { classList: { remove() {} } },
      createElement: () => ({ setAttribute() {} }),
    },
    window: { addEventListener() {} }, confirm: () => true,
    setTimeout: () => ++timerId, clearTimeout() {},
    setInterval: callback => { timers.set(++timerId, callback); return timerId; },
    clearInterval: id => timers.delete(id),
  });
  context.self = context;
  const run = code => vm.runInContext(code, context);
  run(source(file));
  return { context, values, storage, element, elements, timers, options, run,
    advance: milliseconds => { now += milliseconds; } };
}

async function join(env) {
  env.element('playerName').value = 'Demo';
  env.element('employeeId').value = '001';
  await env.run('start()');
}

test('both HTML scripts parse', () => {
  for (const file of [adminFile, gamesFile]) new vm.Script(source(file));
});

test('both screens embed the new wordmark and favicon with no former letter badge', () => {
  for (const file of [adminFile, gamesFile]) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(html, /alt="U.stra PLAY"/);
    assert.match(html, /rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml;base64,/);
    assert.doesNotMatch(html, />G<\/div>|>G<\/span>|<title>G-PLAY/);
  }
});

test('legacy default name displays new brand without changing saved event data', () => {
  const env = environment(adminFile);
  const original = env.values.get('gplay_events');
  env.values.set('gplay_settings_v2', JSON.stringify({ name: 'G-PLAY', statistics: false }));
  assert.equal(env.run('DemoStore.settings().name'), 'U.stra PLAY');
  assert.equal(env.run('DemoStore.settings().statistics'), false);
  assert.equal(env.values.get('gplay_events'), original);
});

test('custom service names survive branding update', () => {
  const env = environment(adminFile);
  env.values.set('gplay_settings_v2', JSON.stringify({ name: 'Custom workspace' }));
  assert.equal(env.run('DemoStore.settings().name'), 'Custom workspace');
});

test('share and preview resolve to the delivered employee HTML', () => {
  const env = environment(adminFile);
  for (const preview of [false, true]) {
    const link = new URL(env.run(`eventLink(data[0], ${preview})`));
    assert.equal(decodeURIComponent(link.pathname), '/' + gamesFile);
    assert.ok(fs.existsSync(path.join(root, decodeURIComponent(link.pathname.slice(1)))));
    assert.equal(link.searchParams.get('preview'), preview ? '1' : null);
  }
});

test('old link cannot start when its event is absent', async () => {
  const env = environment(gamesFile, { registered: false });
  await join(env);
  assert.equal(env.run('DemoStore.records().length'), 0);
  assert.match(env.element('gateMessage').textContent, /등록되지/);
});

test('backup replacement invalidates an old link', () => {
  const env = environment(adminFile);
  env.context.FileReader = class {
    readAsText() { this.result = JSON.stringify({ events: [], participations: [] }); this.onload(); }
  };
  env.run('importFile({target:{files:[{size:100}]}})');
  assert.equal(env.values.get('gplay_events'), '[]');
  const employee = environment();
  for (const [key, value] of env.values) employee.values.set(key, value);
  assert.throws(() => employee.run('requireOpen()'), /등록되지/);
});

test('removal during participation prevents completion', async () => {
  const env = environment();
  await join(env);
  env.values.set('gplay_events', '[]');
  await assert.rejects(env.run("finish('win',true)"), /등록되지/);
  assert.equal(env.run('DemoStore.records()[0].completed'), false);
});

test('preview runs without registered data and never persists participation', async () => {
  const env = environment(gamesFile, { registered: false, preview: true });
  await join(env);
  await env.run("finish('preview',true)");
  assert.equal(env.run('entry.completed'), true);
  assert.equal(env.run('DemoStore.records().length'), 0);
  assert.equal(env.values.size, 0);
});

test('unfinished participation resumes; completed participation keeps its result', async () => {
  const env = environment();
  await join(env);
  const id = env.run('entry.id');
  await join(env);
  assert.equal(env.run('entry.id'), id);
  await env.run("finish('original',true)");
  await join(env);
  assert.equal(env.run('entry.result'), 'original');
  assert.equal(env.run('DemoStore.records().length'), 1);
});

test('ended event rejects result confirmation', async () => {
  const env = environment();
  await join(env);
  env.values.set('gplay_events', JSON.stringify([{ ...event, status: 'ended' }]));
  await assert.rejects(env.run("finish('win',true)"), /종료/);
});

test('quiz storage retry preserves first answer after deadline and creates one completion', async () => {
  const env = environment(gamesFile, { current: quiz });
  await join(env);
  const write = env.storage.setItem;
  env.storage.setItem = () => { throw Error('QuotaExceededError'); };
  await env.options[0].onclick();
  assert.equal(env.run('entry.completed'), false);
  assert.equal(env.timers.size, 0);
  assert.equal(env.options.every(button => button.disabled), true);
  assert.ok(env.elements.has('quizRetry'));
  // A repeated failure must leave an enabled retry control.
  await env.element('quizRetry').onclick();
  assert.equal(env.element('quizRetry').disabled, false);
  env.advance(60000);
  env.storage.setItem = write;
  await env.element('quizRetry').onclick();
  assert.equal(env.run('entry.result'), '정답');
  assert.equal(env.run('entry.won'), true);
  assert.equal(env.run('DemoStore.records().filter(row=>row.completed).length'), 1);
  assert.equal(env.elements.has('quizRetry'), false);
});

test('expired quiz retry remains a timeout', async () => {
  const env = environment(gamesFile, { current: quiz });
  await join(env);
  env.advance(31000);
  const write = env.storage.setItem;
  env.storage.setItem = () => { throw Error('QuotaExceededError'); };
  await [...env.timers.values()][0]();
  // Timer callbacks do not return answerQuiz's promise; flush its microtasks.
  await new Promise(resolve => setImmediate(resolve));
  env.storage.setItem = write;
  await env.element('quizRetry').onclick();
  assert.equal(env.run('entry.result'), '시간 초과');
  assert.equal(env.run('entry.won'), false);
});

test('dashboard chart uses actual records without recursion', () => {
  const env = environment(adminFile);
  assert.match(env.run('chartHtml()'), /최근 7일/);
});
