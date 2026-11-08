import { createHash, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, mkdirSync, chmodSync, fchmodSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './broker.js';
import { smartApiTokens } from './smartapi.js';

export class SessionFile {
  constructor(path, apiKey, { now = () => Date.now() } = {}) {
    this.path = path;
    this.keyHash = createHash('sha256').update(apiKey.trim()).digest('hex');
    this.now = now;
  }
  directory() {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe session directory.');
    chmodSync(directory, 0o700);
  }
  file() {
    let stat;
    try { stat = lstatSync(this.path); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe session file.');
    return stat;
  }
  load() {
    let fd;
    try {
      this.directory();
      if (!this.file()) return null;
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Invalid session file.');
      fchmodSync(fd, 0o600);
      const saved = JSON.parse(readFileSync(fd, 'utf8'));
      if (!saved || saved.version !== 1 || typeof saved.keyHash !== 'string' || !/^[a-f0-9]{64}$/.test(saved.keyHash)) throw new Error('Invalid saved session.');
      if (typeof saved.authToken !== 'string' || typeof saved.feedToken !== 'string') throw new Error('Invalid saved tokens.');
      const { authToken, feedToken } = smartApiTokens(new URLSearchParams({ auth_token: saved.authToken ?? '', feed_token: saved.feedToken ?? '' }));
      const { receivedAt, expiresAt } = saved;
      const expectedExpiry = (Math.floor((receivedAt + 19800000) / 86400000) + 1) * 86400000 - 19800000;
      if (!Number.isSafeInteger(receivedAt) || !Number.isSafeInteger(expiresAt) || receivedAt > this.now() || expiresAt !== expectedExpiry) throw new Error('Invalid saved session times.');
      closeSync(fd); fd = undefined;
      if (expiresAt <= this.now() || saved.keyHash !== this.keyHash) {
        this.clear();
        if (saved.keyHash !== this.keyHash) console.warn('Saved SmartAPI session was removed because the API key changed. Log in again.');
        return null;
      }
      return { authToken, feedToken, receivedAt, expiresAt };
    } catch {
      throw new AppError('Cannot securely restore the local SmartAPI session file. Check its ownership/permissions or remove data/private/smartapi-session.json and log in again. Tokens were not loaded.', 503, 'SMARTAPI_SESSION_FILE');
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  save(session) {
    let fd, temporary, created = false;
    try {
      this.directory();
      this.file();
      temporary = `${this.path}.${randomBytes(12).toString('hex')}.tmp`;
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      writeFileSync(fd, JSON.stringify({
        version: 1, keyHash: this.keyHash, authToken: session.authToken, feedToken: session.feedToken,
        receivedAt: session.receivedAt, expiresAt: session.expiresAt
      }), 'utf8');
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, this.path);
      temporary = undefined;
    } catch {
      throw new AppError('SmartAPI login could not be saved securely to the local session file. Check local storage permissions/space and start a new login.', 503, 'SMARTAPI_SESSION_FILE');
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (temporary && created) {
        try { unlinkSync(temporary); }
        catch (error) { if (error.code !== 'ENOENT') console.error('SmartAPI temporary session file could not be removed. Check local storage permissions.'); }
      }
    }
  }
  clear() {
    try {
      this.directory();
      if (this.file()) unlinkSync(this.path);
    } catch {
      throw new AppError('The local SmartAPI session file could not be removed. Access is cleared in memory; remove data/private/smartapi-session.json before restarting.', 503, 'SMARTAPI_SESSION_FILE');
    }
  }
}
