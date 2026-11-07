const auth = 'Basic ' + Buffer.from('ayue222:12345678').toString('base64');
try {
  const r = await fetch('https://kent.ccwu.cc/p/bot123/getMe', { headers: { authorization: auth }, signal: AbortSignal.timeout(12000) });
  console.log('直连+凭据 →', r.status, (await r.text()).slice(0, 100));
} catch (e) {
  console.log('直连+凭据 → FAIL', (e.cause && (e.cause.code || e.cause.message)) || e.message);
}
try {
  const { ProxyAgent, fetch } = await import('undici');
  const r = await fetch('https://kent.ccwu.cc/p/bot123/getMe', { headers: { authorization: auth }, dispatcher: new ProxyAgent('http://127.0.0.1:59752'), signal: AbortSignal.timeout(12000) });
  console.log('沙盒代理+凭据 →', r.status, (await r.text()).slice(0, 100));
} catch (e) {
  console.log('沙盒代理+凭据 → FAIL', (e.cause && (e.cause.code || e.cause.message)) || e.message);
}
