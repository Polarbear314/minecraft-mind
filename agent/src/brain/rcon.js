// A tiny Minecraft RCON client (the server's remote console), used only by
// the body's code — never by the mind — to grow the world border as MindBot
// thrives. The server listens on 127.0.0.1 (server-ip) with a local password
// from agent/.env. Protocol: little-endian [length][id][type][payload\0\0];
// type 3 = login, 2 = command, 0/2 = responses.
const net = require('net');

function packet(id, type, body) {
  const payload = Buffer.from(String(body), 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeInt16LE(0, 12 + payload.length);
  return buf;
}

/** Split a stream buffer into complete packets: [{ id, type, body }, rest]. */
function readPackets(buf) {
  const out = [];
  let offset = 0;
  while (buf.length - offset >= 4) {
    const len = buf.readInt32LE(offset);
    if (buf.length - offset < 4 + len) break;
    const id = buf.readInt32LE(offset + 4);
    const type = buf.readInt32LE(offset + 8);
    const body = buf.slice(offset + 12, offset + 4 + len - 2).toString('utf8');
    out.push({ id, type, body });
    offset += 4 + len;
  }
  return [out, buf.slice(offset)];
}

/**
 * createRcon({ host, port, password }) -> { command(cmd) -> Promise<string> }.
 * Each command opens a connection, logs in, runs, and closes. Rejects on a
 * bad password, a refused connection, or a 5-second timeout.
 */
function createRcon({ host = '127.0.0.1', port = 25575, password, timeoutMs = 5000 } = {}) {
  async function command(cmd) {
    if (!password) throw new Error('no RCON password configured');
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port });
      let buf = Buffer.alloc(0);
      let loggedIn = false;
      const done = (err, value) => {
        clearTimeout(timer);
        sock.destroy();
        if (err) reject(err); else resolve(value);
      };
      const timer = setTimeout(() => done(new Error('RCON timed out')), timeoutMs);
      sock.on('error', (err) => done(err));
      sock.on('connect', () => sock.write(packet(1, 3, password)));
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const [packets, rest] = readPackets(buf);
        buf = rest;
        for (const p of packets) {
          if (!loggedIn) {
            if (p.id === -1) return done(new Error('RCON password rejected'));
            loggedIn = true;
            sock.write(packet(2, 2, cmd));
          } else if (p.id === 2) {
            return done(null, p.body);
          }
        }
        return undefined;
      });
    });
  }
  return { command };
}

module.exports = { createRcon, packet, readPackets };
