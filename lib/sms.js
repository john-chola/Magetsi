// Outbound SMS. Uses Africa's Talking when AT_API_KEY is set; otherwise logs to the console
// (the server also keeps every message in the sms_outbox table, visible on /admin).
'use strict';

function createSms(env = process.env) {
  const apiKey = env.AT_API_KEY;
  const username = env.AT_USERNAME || 'sandbox';
  const from = env.AT_SENDER_ID || env.AT_SHORTCODE || '';
  const sandbox = username === 'sandbox';
  const url = sandbox ? 'https://api.sandbox.africastalking.com/version1/messaging' : 'https://api.africastalking.com/version1/messaging';

  if (!apiKey) {
    return {
      driver: 'log',
      async send(phone, message) {
        console.log(`[magetsi] SMS (log only, set AT_API_KEY to send) to ${phone}: ${message}`);
        return { ok: true, id: null, status: 'logged' };
      },
    };
  }

  return {
    driver: sandbox ? 'africastalking-sandbox' : 'africastalking',
    async send(phone, message) {
      const body = new URLSearchParams({ username, to: phone, message });
      if (from) body.set('from', from);
      const res = await fetch(url, {
        method: 'POST',
        headers: { apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      let j = null;
      try { j = JSON.parse(text); } catch { /* not JSON */ }
      const r = j && j.SMSMessageData && j.SMSMessageData.Recipients && j.SMSMessageData.Recipients[0];
      if (!res.ok || !r) return { ok: false, id: null, status: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      return { ok: r.status === 'Success', id: r.messageId || null, status: r.status };
    },
  };
}

module.exports = { createSms };
