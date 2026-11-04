// Local editing state is separate from terminal input: it is never replayed automatically.
const STORAGE_KEY = 'qingcode:mobile:workspace-state';
const MAX_ROOMS = 24;
const MAX_CHARACTERS = 600_000;

export function createWorkspaceState({ storage, onError = () => {} }) {
  const rooms = new Map();
  let sequence = 0;
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(saved)) for (const [key, room] of saved.slice(-MAX_ROOMS)) {
      if (typeof key !== 'string' || !room || typeof room !== 'object') continue;
      rooms.set(key, {
        draft: typeof room.draft === 'string' ? room.draft : '',
        project: typeof room.project === 'string' ? room.project : '',
        name: typeof room.name === 'string' ? room.name : '',
        receipts: Array.isArray(room.receipts) ? room.receipts.filter(item => item && typeof item.id === 'string'
          && typeof item.text === 'string' && ['sending', 'received', 'unknown'].includes(item.state)).slice(-3)
          .map(item => ({ ...item, state: item.state === 'sending' ? 'unknown' : item.state })) : [],
      });
    }
  } catch { onError(); }

  function roomFor(key) {
    if (!rooms.has(key)) rooms.set(key, { draft: '', project: '', name: '', receipts: [] });
    return rooms.get(key);
  }
  function save() {
    while (rooms.size > MAX_ROOMS) rooms.delete(rooms.keys().next().value);
    try {
      let serialized = JSON.stringify([...rooms]);
      // Prefer drafts over old submissions when the local history grows too large.
      for (const room of rooms.values()) {
        while (serialized.length > MAX_CHARACTERS && room.receipts.length) {
          room.receipts.shift();
          serialized = JSON.stringify([...rooms]);
        }
      }
      if (serialized.length > MAX_CHARACTERS) { onError(); return; }
      storage.setItem(STORAGE_KEY, serialized);
    } catch { onError(); }
  }
  function touch(key) {
    const room = roomFor(key);
    rooms.delete(key);
    rooms.set(key, room);
    return room;
  }

  const drafts = {
    get(key) { return rooms.get(key)?.draft; },
    set(key, text) { touch(key).draft = text; save(); },
    delete(key) { if (rooms.has(key)) { rooms.get(key).draft = ''; save(); } },
    *keys() { for (const [key, room] of rooms) if (room.draft) yield key; },
    *[Symbol.iterator]() { for (const [key, room] of rooms) if (room.draft) yield [key, room.draft]; },
  };
  return {
    drafts,
    context(key, project, name) { const room = touch(key); room.project = project; room.name = name; save(); },
    submit(key, text) {
      const room = touch(key);
      const receipt = { id: Date.now() + '-' + ++sequence, text, state: 'sending', at: Date.now() };
      room.receipts = [...room.receipts, receipt].slice(-3);
      save();
      return receipt.id;
    },
    settle(key, id, state) {
      const receipt = rooms.get(key)?.receipts.find(item => item.id === id);
      if (receipt && receipt.state === 'sending') { receipt.state = state; save(); }
    },
    recent(key) { return [...(rooms.get(key)?.receipts ?? [])].reverse(); },
    recoverable(host, project, current) {
      return [...rooms].filter(([key, room]) => key !== current && key.startsWith(host + '/')
        && room.project === project && (room.draft || room.receipts.length)).reverse().map(([key, room]) => ({ key, ...room }));
    },
    removeHost(host) { for (const key of rooms.keys()) if (key.startsWith(host + '/')) rooms.delete(key); save(); },
    renameHost(from, to) {
      for (const [key, room] of [...rooms]) if (key.startsWith(from + '/')) {
        for (const receipt of room.receipts) if (receipt.state === 'sending') receipt.state = 'unknown';
        rooms.delete(key); rooms.set(to + key.slice(from.length), room);
      }
      save();
    },
  };
}

export function terminalText(term) {
  const buffer = term.buffer.active;
  const lines = [];
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index);
    const text = line?.translateToString(!buffer.getLine(index + 1)?.isWrapped) ?? '';
    if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join('\n').slice(-600_000);
}

export function searchOffsets(text, query) {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [];
  for (const match of text.matchAll(new RegExp(escaped, 'giu'))) {
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (matches.length === 500) break;
  }
  return matches;
}
