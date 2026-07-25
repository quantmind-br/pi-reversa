/**
 * Shared helpers for turning a Reversa `SKILL.md` file into the prompt block
 * that both the `/reversa-*` aliases and the orchestrator stage tasks inject.
 */

/**
 * Remove a leading YAML frontmatter block, if present.
 *
 * @param {string} content
 * @returns {string}
 */
export function stripFrontmatter(content) {
  if (!content.startsWith("---")) return content.trim();
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (match ? content.slice(match[0].length) : content).trim();
}

/**
 * Build the `<skill …>` block understood by the agent.
 *
 * @param {string} skillName
 * @param {string} skillPath absolute path of the SKILL.md
 * @param {string} baseDir directory references inside the skill resolve against
 * @param {string} body skill body with frontmatter already stripped
 * @returns {string}
 */
export function buildSkillBlock(skillName, skillPath, baseDir, body) {
  return `<skill name="${skillName}" location="${skillPath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
}
