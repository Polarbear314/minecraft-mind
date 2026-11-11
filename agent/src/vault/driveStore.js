// Drive notes: overwrite live numeric fields, preserve the hand-written prose.
const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');
const paths = require('./paths');

const DEFAULT_PROSE = {
  Hunger: 'The need to eat.',
  Fear: 'The alarm system.',
  Curiosity: 'The pull toward the unknown.',
};

/** Update a Drive note's live fields (level 0-100) while keeping its body prose. */
function updateDrive(vaultPath, name, level, decayRate) {
  const file = paths.drivePath(vaultPath, name);
  let data = {};
  let body = DEFAULT_PROSE[paths.titleCase(name)] || `The ${name} drive.`;
  if (fs.existsSync(file)) {
    ({ data, body } = fm.parse(fs.readFileSync(file, 'utf8')));
  }
  const newData = {
    ...data,
    is_a: fm.link('Drive'),
    level: Math.round(level * 10) / 10,
    updated: new Date().toISOString(),
    tags: ['type/drive'],
  };
  if (decayRate != null) newData.decay_rate = decayRate;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fm.stringify(newData, body), 'utf8');
}

module.exports = { updateDrive };
