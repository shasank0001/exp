// Thread/message persistence. Pure Node, no Electron dependency so it is unit-testable.
// Layout under baseDir: threads.json + messages-<threadId>.jsonl (append-only).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_TEXT = 50000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function createStore(baseDir) {
  fs.mkdirSync(baseDir, { recursive: true });
  const threadsFile = path.join(baseDir, 'threads.json');

  function readThreads() {
    try {
      const raw = JSON.parse(fs.readFileSync(threadsFile, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      // Quarantine corruption instead of bricking every thread; the backup keeps data.
      const backup = `${threadsFile}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(threadsFile, backup);
      } catch {
        throw error;
      }
      return [];
    }
  }

  function messagesFile(threadId) {
    if (!ID_PATTERN.test(threadId)) throw new Error('invalid thread id');
    return path.join(baseDir, `messages-${threadId}.jsonl`);
  }

  return {
    listThreads() {
      return readThreads().sort((a, b) => b.updatedAt - a.updatedAt);
    },
    createThread({ title, projectPath }) {
      if (typeof title !== 'string' || !title.trim() || title.length > 200) {
        throw new Error('title must be 1-200 characters');
      }
      if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) {
        throw new Error('projectPath must be absolute');
      }
      const stat = fs.statSync(projectPath, { throwIfNoEntry: false });
      if (!stat || !stat.isDirectory()) throw new Error('projectPath must be an existing directory');
      const now = Date.now();
      const thread = {
        id: newId('th'),
        title: title.trim(),
        projectPath,
        engineId: 'pi',
        createdAt: now,
        updatedAt: now,
      };
      const threads = readThreads();
      threads.push(thread);
      writeAtomic(threadsFile, JSON.stringify(threads, null, 2));
      return thread;
    },
    getMessages(threadId) {
      const file = messagesFile(threadId);
      let raw;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const out = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // Skip corrupt lines rather than losing the whole transcript.
        }
      }
      return out;
    },
    appendMessage(threadId, { role, text }) {
      if (!['user', 'assistant', 'system'].includes(role)) throw new Error('invalid role');
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
        throw new Error('text must be 1-50000 characters');
      }
      const threads = readThreads();
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) throw new Error('unknown thread');
      const message = { id: newId('m'), role, text, createdAt: Date.now() };
      fs.appendFileSync(messagesFile(threadId), `${JSON.stringify(message)}\n`);
      thread.updatedAt = message.createdAt;
      writeAtomic(threadsFile, JSON.stringify(threads, null, 2));
      return message;
    },
  };
}

module.exports = { createStore, MAX_TEXT };
