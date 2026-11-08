import { randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, lstatSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseEnv } from 'node:util';
import { AppError } from './broker.js';
import { smartApiOrigin } from './smartapi-relay.js';

function settings(input) {
  if (!input || Object.keys(input).some(key => !['apiKey', 'relayOrigin'].includes(key)) ||
      typeof input.apiKey !== 'string' || typeof input.relayOrigin !== 'string') {
    throw new AppError('Provide an API key and HTTPS relay origin only.', 400, 'SMARTAPI_CONFIG');
  }
  const apiKey = input.apiKey.trim();
  if (!/^[\x21-\x26\x28-\x7e]{1,256}$/.test(apiKey)) {
    throw new AppError('API key must be 1-256 printable characters, without whitespace or single quotes.', 400, 'SMARTAPI_CONFIG');
  }
  let relayOrigin;
  try { relayOrigin = smartApiOrigin(input.relayOrigin.trim()); }
  catch { throw new AppError('Relay URL must be an HTTPS origin with no callback path, query, credentials or explicit port.', 400, 'SMARTAPI_CONFIG'); }
  return { SMARTAPI_API_KEY: apiKey, SMARTAPI_RELAY_ORIGIN: relayOrigin };
}

function updatedEnv(content, values) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const remaining = new Set(Object.keys(values));
  const assignment = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:'[^']*'|"[^"]*"|`[^`]*`|[^\r\n]*)[^\r\n]*(?:\r?\n|$)/gm;
  let updated = content.replace(assignment, (line, name) => {
    if (!Object.hasOwn(values, name)) return line;
    if (!remaining.delete(name)) return '';
    return `${name}='${values[name]}'${newline}`;
  });
  if (remaining.size) {
    if (updated && !updated.endsWith('\n')) updated += newline;
    for (const name of remaining) updated += `${name}='${values[name]}'${newline}`;
  }
  const parsed = parseEnv(updated);
  const previous = parseEnv(content);
  if (Object.entries(values).some(([name, value]) => parsed[name] !== value) ||
      Object.entries(previous).some(([name, value]) => !Object.hasOwn(values, name) && parsed[name] !== value)) {
    throw new AppError('The existing .env format cannot be updated safely. Edit .env directly.', 409, 'SMARTAPI_CONFIG');
  }
  return updated;
}

export class EnvFile {
  constructor(path) { this.path = path; }
  file() {
    let stat;
    try { stat = lstatSync(this.path); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
        stat.size > 65536 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe environment file.');
    return stat;
  }
  save(input, { port } = {}) {
    const values = settings(input);
    let fd, temporary, created = false;
    try {
      const directory = lstatSync(dirname(this.path));
      if (!directory.isDirectory() || directory.isSymbolicLink() ||
          (process.getuid && directory.uid !== process.getuid())) throw new Error('Unsafe environment directory.');
      const original = this.file();
      let content = '';
      if (original) {
        fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = fstatSync(fd);
        if (opened.ino !== original.ino || opened.dev !== original.dev) throw new Error('Environment file changed.');
        content = readFileSync(fd, 'utf8');
        closeSync(fd); fd = undefined;
      }
      if (port !== undefined) {
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port.');
        if (!Object.hasOwn(parseEnv(content), 'PORT')) values.PORT = String(port);
      }
      const updated = updatedEnv(content, values);
      temporary = `${this.path}.${randomBytes(12).toString('hex')}.tmp`;
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      writeFileSync(fd, updated, 'utf8');
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      const current = this.file();
      if (Boolean(original) !== Boolean(current) || (original &&
          ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => original[key] !== current[key]))) {
        throw new AppError('Local .env changed while saving. Retry or edit it directly.', 409, 'SMARTAPI_CONFIG');
      }
      renameSync(temporary, this.path);
      temporary = undefined;
      return { saved: true, restartRequired: true };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Could not securely save the local .env. Check file ownership, permissions and disk space, or edit .env directly.', 503, 'SMARTAPI_CONFIG_FILE');
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (temporary && created) {
        try { unlinkSync(temporary); }
        catch (error) { if (error.code !== 'ENOENT') console.error('Temporary .env file cleanup failed. Check local file permissions.'); }
      }
    }
  }
}
