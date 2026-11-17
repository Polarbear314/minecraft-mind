// The world border, felt rather than known. Mineflayer doesn't track the
// border, so we listen to the server's border packets ourselves. The border is
// a brainstem matter: standing outside it hurts, and on 2026-11-15 the bot
// reconnected two blocks past the terrarium's edge and died of border damage.
//
// The border is a square (Minecraft borders always are) centered on (x, z)
// with side length `diameter`. A vanilla, untouched border is ~60 million
// blocks wide; anything that large is treated as "no border".
const NO_BORDER_ABOVE = 1e6;

/** Start listening for border packets. Safe on a mock bot (no _client). */
function attachWorldBorder(bot) {
  const client = bot && bot._client;
  if (!client || typeof client.on !== 'function') return;
  const set = (patch) => {
    bot.mindWorldBorder = { ...(bot.mindWorldBorder || { x: 0, z: 0, diameter: Infinity }), ...patch };
  };
  client.on('initialize_world_border', (p) => set({ x: p.x, z: p.z, diameter: p.newDiameter }));
  client.on('world_border_center', (p) => set({ x: p.x, z: p.z }));
  client.on('world_border_size', (p) => set({ diameter: p.diameter }));
  client.on('world_border_lerp_size', (p) => set({ diameter: p.newDiameter }));
}

/** { x, z, half } for a real border, or null when there is none worth minding. */
function borderOf(bot) {
  const b = bot && bot.mindWorldBorder;
  if (!b || !Number.isFinite(b.diameter) || b.diameter > NO_BORDER_ABOVE) return null;
  return { x: b.x, z: b.z, half: b.diameter / 2 };
}

/**
 * Blocks from (x, z) to the nearest border edge: positive inside, negative
 * outside. Square border, so it's the smaller of the two axis gaps.
 */
function edgeDistance(border, x, z) {
  if (!border) return Infinity;
  return Math.min(border.half - Math.abs(x - border.x), border.half - Math.abs(z - border.z));
}

/** Pull a point to at least `margin` blocks inside the border. */
function clampInside(border, x, z, margin = 6) {
  if (!border) return { x, z };
  const lim = Math.max(0, border.half - margin);
  const clamp = (v, c) => Math.min(c + lim, Math.max(c - lim, v));
  return { x: Math.round(clamp(x, border.x)), z: Math.round(clamp(z, border.z)) };
}

module.exports = { attachWorldBorder, borderOf, edgeDistance, clampInside };
