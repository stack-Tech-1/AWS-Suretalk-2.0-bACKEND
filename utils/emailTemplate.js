// utils/emailTemplate.js
// One design for every email SureTalk sends. Table layout + inline styles so it renders the same in
// Gmail (web and app), Outlook, Apple Mail and Yahoo. Colours come from the SureTalk logo.
//
//   const t = require('./emailTemplate');
//   const html = t.render({ category: 'Account', title: 'Verify your email', preheader: '…', toEmail,
//     body: [t.greeting('Ada'), t.p('Thanks for signing up…'), t.button('Verify my email', link)] });
//
// Every helper escapes the text it is given. t.raw(html) inserts markup you built yourself.

const SITE = () => process.env.FRONTEND_URL || 'https://app.suretalknow.com';
const SUPPORT_EMAIL = 'contact@suretalknow.com';

const C = {
  navy: '#0C1128',      // headings, wordmark
  text: '#374151',      // body copy
  muted: '#6B7280',     // secondary copy
  faint: '#9CA3AF',
  line: '#E5E7EB',
  page: '#F3F4F8',      // outer background
  card: '#FFFFFF',
  blue: '#5371FF',      // logo blue: buttons, links
  coral: '#FF5758',     // logo coral: urgent actions, warnings
  green: '#0E9F6E',
  tint: { info: '#EEF1FF', warn: '#FFF1F1', success: '#ECFDF5', neutral: '#F9FAFB' },
  edge: { info: '#5371FF', warn: '#FF5758', success: '#0E9F6E', neutral: '#D1D5DB' },
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// Only http(s) links are allowed into href attributes
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? esc(u) : '#');

const RAW = Symbol('raw');
const raw = (html) => ({ [RAW]: String(html) });
const out = (part) => (part && part[RAW] !== undefined ? part[RAW] : esc(part));

// ── Building blocks (each returns a table row-safe chunk of HTML) ─────────────
const greeting = (name) => raw(`<p style="margin:0 0 16px;font:600 17px/1.5 ${FONT};color:${C.navy}">Hi ${esc(name || 'there')},</p>`);
// A greeting-style line with your own words, e.g. "Welcome, Ada!"
const lead = (text) => raw(`<p style="margin:0 0 16px;font:600 17px/1.5 ${FONT};color:${C.navy}">${out(text)}</p>`);
const list = (items) => raw(`<ul style="margin:0 0 18px;padding-left:22px;font:400 15px/1.9 ${FONT};color:${C.text}">${items.map(i => `<li>${out(i)}</li>`).join('')}</ul>`);
// Monospace block (technical details in internal alerts)
const pre = (text) => raw(`<pre style="margin:0 0 18px;padding:14px 16px;background:${C.tint.neutral};border:1px solid ${C.line};border-radius:8px;font:400 12px/1.5 Consolas,Menlo,monospace;color:${C.text};white-space:pre-wrap;word-break:break-all">${esc(text)}</pre>`);
const p = (text, { muted = false, small = false, center = false } = {}) =>
  raw(`<p style="margin:0 0 16px;font:400 ${small ? 13 : 15}px/1.7 ${FONT};color:${muted ? C.muted : C.text};${center ? 'text-align:center;' : ''}">${out(text)}</p>`);
// Mixed text: pass an array of strings and t.b()/t.a() pieces
const rich = (...parts) => raw(parts.map(out).join(''));
const b = (text) => raw(`<strong style="color:${C.navy};font-weight:600">${esc(text)}</strong>`);
const a = (text, url) => raw(`<a href="${safeUrl(url)}" style="color:${C.blue};text-decoration:underline">${esc(text)}</a>`);

// Bulletproof button (works in Outlook): tone 'primary' (blue) or 'urgent' (coral)
const button = (label, url, { tone = 'primary' } = {}) => {
  const bg = tone === 'urgent' ? C.coral : C.blue;
  return raw(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:28px auto">
  <tr><td align="center" bgcolor="${bg}" style="border-radius:10px;background:${bg}">
    <a href="${safeUrl(url)}" target="_blank" style="display:inline-block;padding:14px 30px;font:600 15px/1 ${FONT};color:#FFFFFF;text-decoration:none;border-radius:10px">${esc(label)}</a>
  </td></tr></table>`);
};

// "Or paste this link" fallback under a button
const linkFallback = (url) => raw(`<p style="margin:0 0 16px;font:400 13px/1.6 ${FONT};color:${C.muted}">If the button doesn't work, paste this link into your browser:<br><a href="${safeUrl(url)}" style="color:${C.blue};word-break:break-all">${esc(url)}</a></p>`);

// Coloured notice box: tone 'info' | 'warn' | 'success' | 'neutral'; title optional
const callout = (body, { tone = 'info', title } = {}) => raw(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px">
  <tr><td style="background:${C.tint[tone]};border-left:4px solid ${C.edge[tone]};border-radius:0 10px 10px 0;padding:16px 18px">
    ${title ? `<p style="margin:0 0 6px;font:600 14px/1.4 ${FONT};color:${C.navy}">${esc(title)}</p>` : ''}
    <p style="margin:0;font:400 14px/1.6 ${FONT};color:${C.text}">${out(body)}</p>
  </td></tr></table>`);

// Label / value rows, e.g. [['Plan','Premium'],['Amount','$12.99']]
const details = (rows) => raw(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 22px;border:1px solid ${C.line};border-radius:10px;border-collapse:separate">
  ${rows.filter(Boolean).map(([label, value], i) => `<tr>
    <td style="padding:12px 16px;font:400 14px/1.4 ${FONT};color:${C.muted};${i ? `border-top:1px solid ${C.line};` : ''}">${esc(label)}</td>
    <td align="right" style="padding:12px 16px;font:600 14px/1.4 ${FONT};color:${C.navy};${i ? `border-top:1px solid ${C.line};` : ''}">${out(value)}</td>
  </tr>`).join('')}
</table>`);

// Numbered steps / feature list with a coloured number
const steps = (items) => raw(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px">
  ${items.map(([title, text], i) => `<tr><td valign="top" width="40" style="padding:0 0 16px">
      <div style="width:28px;height:28px;border-radius:14px;background:${C.tint.info};color:${C.blue};font:700 13px/28px ${FONT};text-align:center">${i + 1}</div>
    </td><td valign="top" style="padding:2px 0 16px">
      <p style="margin:0 0 2px;font:600 15px/1.4 ${FONT};color:${C.navy}">${esc(title)}</p>
      <p style="margin:0;font:400 14px/1.6 ${FONT};color:${C.muted}">${out(text)}</p>
    </td></tr>`).join('')}
</table>`);

const divider = () => raw(`<div style="height:1px;line-height:1px;background:${C.line};margin:24px 0">&nbsp;</div>`);
const signoff = () => raw(`<p style="margin:24px 0 0;font:400 15px/1.7 ${FONT};color:${C.text}">The SureTalk team</p>`);

// ── Full email ───────────────────────────────────────────────────────────────
// category: small label top-right ('Account', 'Billing', 'Voice message', 'Legacy Vault', 'Admin')
// accent: 'brand' (coral→blue bar) | 'urgent' (coral bar) | 'success' (green bar)
// accountLinks: false for people who may not have an account (voice message recipients, will beneficiaries)
function render({ category = '', title, subtitle, preheader = '', body = [], toEmail, reason, accent = 'brand', accountLinks = true }) {
  const site = SITE();
  const logo = `${site}/logo-icon.png`;
  const bar = accent === 'urgent' ? C.coral : accent === 'success' ? C.green : C.blue;
  const barStyle = accent === 'brand'
    ? `background:${C.blue};background-image:linear-gradient(90deg,${C.coral},${C.blue})`
    : `background:${bar}`;
  const why = reason ? esc(reason) : `You're receiving this email because you have a SureTalk account${toEmail ? ` (${esc(toEmail)})` : ''}.`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(title)}</title>
<!--[if mso]><style>table,td,p,a{font-family:Arial,sans-serif!important}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page}">
<tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
    <tr><td style="height:5px;line-height:5px;font-size:0;border-radius:12px 12px 0 0;${barStyle}" bgcolor="${bar}">&nbsp;</td></tr>
    <tr><td bgcolor="${C.card}" style="background:${C.card};padding:24px 36px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle" width="44"><img src="${logo}" width="36" height="36" alt="SureTalk" style="display:block;border:0;width:36px;height:36px"></td>
        <td valign="middle" style="font:800 20px/1 ${FONT};color:${C.navy};letter-spacing:-0.3px">SureTalk</td>
        <td valign="middle" align="right" style="font:600 11px/1 ${FONT};color:${C.faint};letter-spacing:1.2px;text-transform:uppercase">${esc(category)}</td>
      </tr></table>
    </td></tr>
    <tr><td bgcolor="${C.card}" style="background:${C.card};padding:28px 36px 8px">
      <h1 style="margin:0 0 ${subtitle ? 8 : 20}px;font:700 26px/1.25 ${FONT};color:${C.navy};letter-spacing:-0.4px">${esc(title)}</h1>
      ${subtitle ? `<p style="margin:0 0 22px;font:400 16px/1.5 ${FONT};color:${C.muted}">${esc(subtitle)}</p>` : ''}
    </td></tr>
    <tr><td bgcolor="${C.card}" style="background:${C.card};padding:0 36px 32px;border-radius:0 0 12px 12px">
      ${body.map(out).join('\n      ')}
    </td></tr>
    <tr><td style="padding:24px 36px 8px" align="center">
      <p style="margin:0 0 10px;font:400 13px/1.6 ${FONT};color:${C.muted}">
        ${accountLinks ? `<a href="${site}/usersDashboard" style="color:${C.muted};text-decoration:underline">Dashboard</a> &nbsp;&middot;&nbsp;
        <a href="${site}/usersDashboard/settings" style="color:${C.muted};text-decoration:underline">Settings</a> &nbsp;&middot;&nbsp;` : 'Questions? '}
        <a href="mailto:${SUPPORT_EMAIL}" style="color:${C.muted};text-decoration:underline">${SUPPORT_EMAIL}</a>
      </p>
      <p style="margin:0 0 6px;font:400 12px/1.6 ${FONT};color:${C.faint}">${why}</p>
      <p style="margin:0;font:400 12px/1.6 ${FONT};color:${C.faint}">&copy; ${new Date().getFullYear()} SureTalk &middot; Voice messaging without internet</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

// Plain-text version (sent alongside the HTML; some people and spam filters only read this)
function text({ title, lines = [], toEmail }) {
  return [
    `SureTalk: ${title}`,
    '',
    ...lines,
    '',
    '--',
    `SureTalk · ${SITE()}`,
    `Questions? ${SUPPORT_EMAIL}`,
    toEmail ? `Sent to ${toEmail} because you have a SureTalk account.` : '',
  ].filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n');
}

module.exports = { render, text, raw, esc, greeting, lead, p, rich, b, a, button, linkFallback, callout, details, steps, list, pre, divider, signoff, SUPPORT_EMAIL, COLORS: C };
