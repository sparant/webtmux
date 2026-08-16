// The ⤓ dropdown's other two sections: moving whole FILES between the machine
// this browser runs on and the machine tmux runs on.
//
// The dropdown already had one destination question ("save the pane's buffer
// where?") and answering it needed a whole module of careful English, because
// webtmux and tmux need not share a filesystem and a confident wrong answer is
// worse than none (see save-target.js). File transfer inherits that problem and
// adds a second one on top: there are now TWO machines in play in every sentence,
// and they are not the two the save section talks about.
//
// So the rule this module exists to enforce is that the direction is never
// implied. Every label, every button, and every banner names both ends —
// "this browser" and "the machine tmux runs on" — in the order the bytes travel.
// "Upload" and "Download" alone are exactly the words that feel obvious to
// whoever wrote them and are a coin flip to everybody else: upload to WHERE, from
// WHICH of the machines you are looking at? A person who has ssh'd somewhere and
// opened webtmux over the tunnel has at least two machines on screen and no way
// to tell which one a bare arrow means.
//
// webtmux itself is deliberately never named as an endpoint even though every
// byte passes through it. It is plumbing. Naming it would add a third machine to
// a sentence that is already asking the reader to hold two.
//
// Import-free apart from formatBytes, so node can unit-test the wording.

import { formatBytes } from './scrollback.js';

// The two ends, in the exact words used everywhere. Constants rather than
// literals scattered through the toolbar template: the whole design depends on
// these phrases being identical in all nine places they appear, and nine chances
// to paraphrase is nine chances to describe a different machine.
export const HERE = 'this browser';
export const THERE = 'the machine tmux runs on';

// The heading's subtitle — the one sentence that has to land before any control
// below it makes sense.
export const TRANSFER_BLURB = `Copy files between ${HERE} and ${THERE}. `
  + 'Useful when you reached this terminal over ssh: the files are on that machine, not on yours.';

export const UPLOAD_TITLE = `↑ Upload — from ${HERE} to ${THERE}`;
export const DOWNLOAD_TITLE = `↓ Download — from ${THERE} to ${HERE}`;

// ---- what the user picked to upload ---------------------------------------------

// Turn a FileList into the thing the uploader actually sends.
//
// `webkitRelativePath` is the whole reason folder upload works: for a directory
// pick the browser fills it with the file's path BELOW the chosen folder
// ("project/src/util.js"), and it is empty for an ordinary multi-file pick. Using
// `name` in its place — which is what you get if you forget the field exists —
// silently flattens a tree, and a flattened tree quietly merges every src/index.js
// in the selection into whichever one arrived last.
export function uploadPlan(files) {
  const list = Array.from(files || []);
  const entries = list.map((file) => ({
    file,
    rel: String(file.webkitRelativePath || file.name || ''),
  })).filter((e) => e.rel !== '');
  const bytes = entries.reduce((n, e) => n + (Number(e.file.size) || 0), 0);
  // The folder's own name, when this was a folder pick — every rel then shares
  // one first segment. Reported so the confirmation can say WHICH folder rather
  // than just how many files, since picking the wrong one is the easy mistake.
  let folder = '';
  if (entries.length && entries.every((e) => e.rel.includes('/'))) {
    const first = entries[0].rel.split('/')[0];
    if (entries.every((e) => e.rel.split('/')[0] === first)) folder = first;
  }
  return { entries, files: entries.length, bytes, folder };
}

// What the dropdown says about a pick, before it is sent. Names the folder when
// there is one: "42 files" is true of any folder on the machine, and the mistake
// worth catching is having chosen the wrong one.
export function transferSummary(plan) {
  if (!plan || !plan.files) return '';
  const size = formatBytes(plan.bytes);
  if (plan.folder) {
    return `folder “${plan.folder}” — ${plan.files} file${plan.files === 1 ? '' : 's'}, ${size}`;
  }
  if (plan.files === 1) return `${plan.entries[0].rel} — ${size}`;
  return `${plan.files} files — ${size}`;
}

// The upload button's label. Restates the destination because it is the last
// thing read before the click, and it is the click that cannot be taken back.
export function uploadLabel(plan) {
  if (!plan || !plan.files) return `Upload to ${THERE}`;
  const what = plan.folder
    ? `folder “${plan.folder}”`
    : `${plan.files} file${plan.files === 1 ? '' : 's'}`;
  return `Upload ${what} to ${THERE}`;
}

// ---- URLs -----------------------------------------------------------------------

// Build a transfer URL. `base` is the page's own path (it ends in "/"), so the
// routes sit beside the page and inherit its Basic auth — which is the entire
// authentication story for transfers, and why there is no token to thread here.
//
// Empty values are DROPPED rather than sent blank: the server distinguishes "no
// window id" from "a window id of ''", and a blank `dir` would override a real
// saved directory with nothing.
export function transferUrl(base, kind, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === false || v === '') continue;
    q.set(k, v === true ? '1' : String(v));
  }
  const qs = q.toString();
  return `${base}transfer/${kind}${qs ? `?${qs}` : ''}`;
}

// ---- what to prefill the two path boxes with -------------------------------------

// The directory a transfer should start from, per the server's SaveEnv.
//
// baseDir, not paneDir. They are the same directory in the ordinary deployment,
// and where they differ (webtmux in a container reaching the host through a
// mapping) baseDir is the one that exists for the process doing the reading —
// so prefilling paneDir would hand the user a path that looks right, matches
// their shell, and fails.
export function defaultTransferDir(info) {
  if (!info) return '';
  return String(info.baseDir || '');
}

// A path box's placeholder: a real example built from the directory in force, so
// the shape of an acceptable answer is visible without typing anything.
export function transferPlaceholder(info, kind) {
  const dir = defaultTransferDir(info);
  if (!dir) return kind === 'upload' ? '/data' : '/data/build.log';
  const sep = dir.endsWith('/') ? '' : '/';
  return kind === 'upload' ? dir : `${dir}${sep}build.log`;
}

// ---- hints and banners ------------------------------------------------------------

// The line under the transfer controls. Returns {text, level}.
//
// The blocked case is not restated here — the save section above already asks for
// a directory, in its own words, and this points at that one question instead of
// asking it a second time in different words. Two boxes for one answer is how a
// user ends up believing they are different questions.
export function transferHint(info) {
  if (!info) {
    return { level: 'info', text: `Paths are on ${THERE}. A folder downloads as a .zip.` };
  }
  if (info.blocked || info.chosenError) {
    return {
      level: 'warn',
      text: `webtmux has no directory it shares with ${THERE}, so it cannot read or write files there yet. `
        + 'Name one in the box above and transfers become available too.',
    };
  }
  const where = defaultTransferDir(info);
  const tail = 'A folder downloads as a .zip; ~ and absolute paths are honored as-is.';
  if (!where) return { level: 'info', text: `Paths are on ${THERE}. ${tail}` };
  if (info.container && !info.paneVisible) {
    // The container case, stated the same way the save hint states it: name BOTH
    // directories, or the message reads as a refusal rather than an explanation.
    return {
      level: 'warn',
      text: `⚠ webtmux reaches ${THERE} only through ${where}${info.paneDir ? `, not ${info.paneDir}` : ''}`
        + `. Transfers are limited to what is inside it. ${tail}`,
    };
  }
  return { level: 'info', text: `Plain names are relative to ${where} on ${THERE}. ${tail}` };
}

// Turn the server's download probe into the dropdown's banner. The probe exists
// so a refusal lands HERE, beside the path that caused it, rather than as a
// navigation to an error page in a tab the user then has to come back from.
export function probeBanner(probe) {
  if (!probe) return { state: 'err', text: 'No answer from webtmux.' };
  if (!probe.ok) return { state: 'err', text: probe.error || 'That path could not be read.' };
  const size = formatBytes(probe.bytes);
  if (probe.isDir) {
    const skipped = (probe.skipped || []).length;
    // What a zip LEAVES OUT is said before the download, not after: an archive
    // quietly missing things is the failure nobody thinks to check for.
    const note = skipped
      ? ` — skipping ${skipped} item${skipped === 1 ? '' : 's'} (${(probe.skipped || []).slice(0, 3).join(', ')}${skipped > 3 ? '…' : ''})`
      : '';
    return {
      state: 'saving',
      text: `Zipping ${probe.files} file${probe.files === 1 ? '' : 's'}, ${size} into ${probe.name}${note}`,
    };
  }
  return { state: 'saving', text: `Downloading ${probe.name} — ${size}` };
}

// Turn an upload reply into the banner. Three shapes, because a folder upload is
// one gesture but many files and the interesting outcome is the partial one:
// everything worked, nothing worked, or most of it worked and these are the ones
// that didn't.
export function uploadBanner(out) {
  if (!out) return { state: 'err', text: 'No answer from webtmux.' };
  const landed = out.files
    ? `${out.files} file${out.files === 1 ? '' : 's'} (${formatBytes(out.bytes)}) → ${out.dir}`
    : '';
  if (out.ok) return { state: 'ok', text: `Uploaded ${landed} on ${THERE}` };
  if (!out.files) {
    return { state: 'err', text: out.error || 'The upload failed.' };
  }
  const why = (out.failures || []).map((f) => `${f.name}: ${f.error}`);
  const more = out.skipped > why.length ? `\n…and ${out.skipped - why.length} more` : '';
  // 'partial', NOT 'confirm'. The save section above uses 'confirm' to mean "that
  // file exists, here is an Overwrite button", and the dropdown renders those
  // buttons from the state alone — so reusing the word here would hang a working
  // Overwrite button off a banner that has nothing left to overwrite.
  return {
    state: 'partial',
    text: `Uploaded ${landed}, but ${out.skipped} did not:\n${why.join('\n')}${more}`,
  };
}

// The progress line while an upload's bytes are moving.
//
// Only uploads report progress here. A download is handed to the browser as a
// real navigation, so it gets the browser's own progress bar and Cancel button —
// which survive closing this dropdown, and which this dropdown could not match.
export function uploadProgressText(sent, total) {
  if (!total) return `${formatBytes(sent)} → ${THERE}`;
  const pct = Math.min(100, Math.round((sent / total) * 100));
  return `${pct}% — ${formatBytes(sent)} of ${formatBytes(total)} → ${THERE}`;
}
