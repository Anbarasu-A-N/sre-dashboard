'use strict';

const { bad } = require('./errors');
const { LIMITS } = require('./config');

function str(value, name, { max, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw bad(`${name} is required`);
    return '';
  }
  if (typeof value !== 'string') throw bad(`${name} must be text`);
  const v = value.trim();
  if (required && !v) throw bad(`${name} is required`);
  if (max && v.length > max) throw bad(`${name} must be at most ${max} characters`);
  return v;
}

function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) throw bad(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

function isoDate(value, name) {
  if (typeof value !== 'string' || !value) throw bad(`${name} is required`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw bad(`${name} is not a valid date/time`);
  return d.toISOString();
}

function optionalIsoDate(value, name) {
  if (value === undefined || value === null || value === '') return null;
  return isoDate(value, name);
}

function id(value, name = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw bad(`${name} must be a positive integer`);
  return n;
}

// Links: [{name, url}]. Only http(s) is accepted so a stored link can never be
// a javascript:/data: URL. Bare hosts like "grafana.internal/d/abc" get https://.
function links(value, name = 'links') {
  if (!Array.isArray(value)) throw bad(`${name} must be a list`);
  if (value.length > LIMITS.linksPerItem) throw bad(`${name}: at most ${LIMITS.linksPerItem} links allowed`);

  return value.map((item, i) => {
    const label = `${name}[${i + 1}]`;
    if (!item || typeof item !== 'object') throw bad(`${label} is invalid`);
    let url = str(item.url, `${label} URL`, { required: true, max: LIMITS.linkUrl });
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;

    let parsed;
    try { parsed = new URL(url); } catch { throw bad(`${label} URL is not valid`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw bad(`${label} URL must start with http:// or https://`);
    }
    const linkName = str(item.name, `${label} name`, { max: LIMITS.linkName }) || parsed.hostname;
    return { name: linkName, url: parsed.href };
  });
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
function username(value) {
  const v = str(value, 'username', { required: true }).toLowerCase();
  if (v.length < LIMITS.usernameMin || v.length > LIMITS.usernameMax || !USERNAME_RE.test(v)) {
    throw bad(`username must be ${LIMITS.usernameMin}-${LIMITS.usernameMax} characters: letters, numbers, dot, dash or underscore`);
  }
  return v;
}

function password(value, name = 'password') {
  if (typeof value !== 'string') throw bad(`${name} is required`);
  if (value.length < LIMITS.passwordMin) throw bad(`${name} must be at least ${LIMITS.passwordMin} characters`);
  if (value.length > LIMITS.passwordMax) throw bad(`${name} must be at most ${LIMITS.passwordMax} characters`);
  return value;
}

module.exports = { str, oneOf, isoDate, optionalIsoDate, id, links, username, password };
