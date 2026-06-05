// git-style conflict markers written by the 3-way merge
export const CONFLICT_START = '<<<<<<< Working (your changes)';
export const CONFLICT_SEP = '=======';
export const CONFLICT_END = '>>>>>>> Server (origin)';

// matches a line beginning with a 7-char conflict marker
const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})(\s|$)/m;

export const hasConflictMarkers = (text: string) => CONFLICT_MARKER_RE.test(text);
