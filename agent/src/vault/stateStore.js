// Current State: the agent's live working memory. Fully overwritten every tick.
const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');
const paths = require('./paths');

function moodOf(dominant, levels) {
  const level = levels[dominant];
  if (dominant === 'fear') return level > 60 ? 'terrified' : 'uneasy';
  if (dominant === 'hunger') return level > 60 ? 'starving' : 'peckish';
  return level > 60 ? 'restless' : 'content';
}

/**
 * snapshot: {
 *   drives: { hunger, fear, curiosity },   // 0-100
 *   dominant: 'fear',
 *   position: Vec3-like {x,y,z} or null,
 *   action: { type, ... },
 *   location: 'Plains' | null,
 *   health, food, isDay,
 * }
 */
function updateCurrentState(vaultPath, snapshot) {
  const { drives, dominant, position, action, location, health, food, isDay, goal, thought } = snapshot;
  const mood = moodOf(dominant, drives);
  const pos = position
    ? `${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}`
    : 'unknown';

  const data = {
    is_a: fm.link('Agent'),
    updated: new Date().toISOString(),
    hunger: Math.round(drives.hunger * 10) / 10,
    fear: Math.round(drives.fear * 10) / 10,
    curiosity: Math.round(drives.curiosity * 10) / 10,
    dominant_drive: fm.link(dominant.charAt(0).toUpperCase() + dominant.slice(1)),
    position: pos,
    current_action: action ? action.type : 'idle',
    health: health != null ? health : null,
    food: food != null ? food : null,
    time_of_day: isDay ? 'day' : 'night',
    mood,
    tags: ['type/entity'],
  };
  if (location) data.located_in = [fm.link(location)];
  if (goal) data.pursuing = fm.link(goal);

  const body =
    `The agent is ${mood}: ${dominant} (${Math.round(drives.hunger)}/${Math.round(drives.fear)}/` +
    `${Math.round(drives.curiosity)} hunger/fear/curiosity) dominates, so it is currently choosing to ` +
    `**${action ? action.type : 'idle'}**${location ? ` in ${location}` : ''} at ${pos}, ` +
    `${isDay ? 'in daylight' : 'in the dark'} with ${health != null ? health : '?'} health.` +
    (goal ? ` Standing goal: ${goal}.` : '') +
    (thought ? `\n\n> ${thought}` : '');

  const file = paths.statePath(vaultPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fm.stringify(data, body), 'utf8');
}

module.exports = { updateCurrentState };
