// Resolves filesystem paths inside the vault and converts raw Minecraft names
// (snake_case) into unique Title Case note titles.
const path = require('path');

/** Strip characters that are illegal in filenames or break Obsidian links. */
function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 'oak_log' -> 'Oak Log' */
function titleCase(rawName) {
  return sanitize(rawName)
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** ISO timestamp -> filename-safe compact form: '2026-07-06T21:14:00.000Z' -> '2026-07-06T2114' */
function compactTimestamp(iso) {
  return iso.slice(0, 16).replace(':', '');
}

function conceptPath(vaultPath, classPath, title) {
  return path.join(vaultPath, 'Concepts', ...classPath.split('/'), `${title}.md`);
}

function drivePath(vaultPath, name) {
  return path.join(vaultPath, 'Drives', `${titleCase(name)}.md`);
}

function locationPath(vaultPath, title) {
  return path.join(vaultPath, 'Locations', `${title}.md`);
}

function strategiesDir(vaultPath) {
  return path.join(vaultPath, 'Concepts', 'Abstract', 'Strategy');
}

function strategyPath(vaultPath, title) {
  return path.join(strategiesDir(vaultPath), `${sanitize(title)}.md`);
}

function insightsDir(vaultPath) {
  return path.join(vaultPath, 'Concepts', 'Abstract', 'Insight');
}

function insightPath(vaultPath, title) {
  return path.join(insightsDir(vaultPath), `${sanitize(title)}.md`);
}

function skillsDir(vaultPath) {
  return path.join(vaultPath, 'Concepts', 'Abstract', 'Skill');
}

function skillPath(vaultPath, title) {
  return path.join(skillsDir(vaultPath), `${sanitize(title)}.md`);
}

function goalsDir(vaultPath) {
  return path.join(vaultPath, 'Goals');
}

function goalPath(vaultPath, title) {
  return path.join(goalsDir(vaultPath), `${sanitize(title)}.md`);
}

function experiencesDir(vaultPath) {
  return path.join(vaultPath, 'Experiences');
}

function experiencePath(vaultPath, isoTimestamp, title) {
  return path.join(experiencesDir(vaultPath), `${compactTimestamp(isoTimestamp)} - ${sanitize(title)}.md`);
}

function statePath(vaultPath) {
  return path.join(vaultPath, 'State', 'Current State.md');
}

function intentionPath(vaultPath) {
  return path.join(vaultPath, 'State', 'Current Intention.md');
}

module.exports = {
  sanitize,
  titleCase,
  compactTimestamp,
  conceptPath,
  drivePath,
  locationPath,
  strategiesDir,
  strategyPath,
  insightsDir,
  insightPath,
  skillsDir,
  skillPath,
  goalsDir,
  goalPath,
  experiencesDir,
  experiencePath,
  statePath,
  intentionPath,
};
