// Local editing state is separate from terminal input: it is never replayed automatically.
const STORAGE_KEY = 'qingcode:mobile:workspace-state';
const MAX_ROOMS = 24;
const MAX_CHARACTERS = 600_000;

export function createWorkspaceState({ storage, onError = () => {}, onSaved = () => {} }) {
  const rooms = new Map();
  let sequence = 0;
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(saved)) for (const entry of saved) {
      if (!Array.isArray(entry)) continue;
      const [key, room] = entry;
      if (typeof key !== 'string' || !room || typeof room !== 'object') continue;
      rooms.set(key, {
        draft: typeof room.draft === 'string' ? room.draft : '',
        project: typeof room.project === 'string' ? room.project : '',
        name: typeof room.name === 'string' ? room.name : '',
        receipts: Array.isArray(room.receipts) ? room.receipts.filter(item => item && typeof item.id === 'string'
          && typeof item.text === 'string' && ['sending', 'received', 'unknown'].includes(item.state))
          .map(item => ({ ...item, state: item.state === 'sending' ? 'unknown' : item.state })) : [],
      });
    }
  } catch { onError(); }

  function roomFor(key) {
    if (!rooms.has(key)) rooms.set(key, { draft: '', project: '', name: '', receipts: [] });
    return rooms.get(key);
  }
  function save(current) {
    try {
      // Limits apply to disposable history. Drafts and unconfirmed submissions must
      // survive both pruning and reload, even when more than 24 sessions have them.
      const saved = new Map([...rooms].map(([key, room]) => [key, { ...room, receipts: [...room.receipts] }]));
      const protectedRoom = room => !!room.draft || room.receipts.some(item => item.state !== 'received');
      for (const [key, room] of saved) {
        if (saved.size <= MAX_ROOMS) break;
        if (key !== current && !room.draft && !room.receipts.length) saved.delete(key);
      }
      for (const [key, room] of saved) {
        if (saved.size <= MAX_ROOMS) break;
        if (key !== current && !protectedRoom(room)) saved.delete(key);
      }
      let serialized = JSON.stringify([...saved]);
      for (const room of saved.values()) {
        while (serialized.length > MAX_CHARACTERS) {
          const index = room.receipts.findIndex(item => item.state === 'received');
          if (index < 0) break;
          room.receipts.splice(index, 1);
          serialized = JSON.stringify([...saved]);
        }
      }
      // The character budget is soft for protected text; actual quota failures are
      // reported without deleting anything in memory or the previously saved data.
      storage.setItem(STORAGE_KEY, serialized);
      rooms.clear();
      for (const [key, room] of saved) rooms.set(key, room);
      onSaved();
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
    set(key, text) { touch(key).draft = text; save(key); },
    delete(key) { if (rooms.has(key)) { rooms.get(key).draft = ''; save(key); } },
    *keys() { for (const [key, room] of rooms) if (room.draft) yield key; },
    *[Symbol.iterator]() { for (const [key, room] of rooms) if (room.draft) yield [key, room.draft]; },
  };
  return {
    drafts,
    context(key, project, name) { const room = touch(key); room.project = project; room.name = name; save(key); },
    submit(key, text) {
      const room = touch(key);
      const receipt = { id: Date.now() + '-' + ++sequence, text, state: 'sending', at: Date.now() };
      room.receipts = [...room.receipts, receipt];
      save(key);
      return receipt.id;
    },
    settle(key, id, state) {
      const receipt = rooms.get(key)?.receipts.find(item => item.id === id);
      if (receipt && receipt.state === 'sending') {
        receipt.state = state;
        const room = rooms.get(key);
        const recent = new Set(room.receipts.filter(item => item.state === 'received').slice(-3));
        room.receipts = room.receipts.filter(item => item.state !== 'received' || recent.has(item));
        save(key);
      }
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
