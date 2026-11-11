// Pure, read-only perception: turns live bot state into a plain observation
// object. No vault access and no decision logic here, so it runs identically
// against a real mineflayer bot or the mock bot in simulate.js.
const { isHostile, FOOD_ITEMS } = require('../vault/ontologyMap');

const PERCEPTION_RADIUS = 16;

function perceive(bot) {
  const me = bot.entity;
  const myPos = me && me.position;

  const nearbyEntities = [];
  const nearbyItems = []; // things lying on the ground (dropped item entities)
  if (myPos && bot.entities) {
    for (const entity of Object.values(bot.entities)) {
      if (!entity || entity === me || !entity.position || !entity.name) continue;
      if (entity.name === 'experience_orb') continue;
      const distance = entity.position.distanceTo(myPos);
      if (distance > PERCEPTION_RADIUS) continue;
      if (entity.name === 'item') {
        // Resolve what the dropped stack actually is, when mineflayer can.
        let dropped = null;
        try {
          dropped = typeof entity.getDroppedItem === 'function' ? entity.getDroppedItem() : null;
        } catch (_) { /* metadata not loaded yet — fine */ }
        nearbyItems.push({
          name: (dropped && dropped.name) || 'item',
          distance: Math.round(distance * 10) / 10,
          position: entity.position,
        });
        continue;
      }
      // Other people are perceived by name, not as anonymous 'player' blobs —
      // the vault gives each person their own Concept (Entity/Person/<Name>).
      const isPlayer = entity.type === 'player' && entity.username;
      nearbyEntities.push({
        name: isPlayer ? entity.username : entity.name,
        isPlayer: !!isPlayer,
        distance: Math.round(distance * 10) / 10,
        position: entity.position,
        hostile: !isPlayer && isHostile(entity.name),
      });
    }
  }
  nearbyEntities.sort((a, b) => a.distance - b.distance);
  nearbyItems.sort((a, b) => a.distance - b.distance);

  const hostiles = nearbyEntities.filter((e) => e.hostile);
  const items = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  const inventoryFood = items.filter((i) => FOOD_ITEMS.has(i.name));

  return {
    health: bot.health,
    food: bot.food,
    isDay: bot.time ? !!bot.time.isDay : true,
    position: myPos || null,
    nearbyEntities,
    nearbyItems,
    nearestHostile: hostiles[0] || null,
    hostileCount: hostiles.length,
    inventory: items.map((i) => ({ name: i.name, count: i.count })),
    inventoryFood,
    heldItem: bot.heldItem ? bot.heldItem.name : null,
  };
}

module.exports = { perceive, PERCEPTION_RADIUS };
