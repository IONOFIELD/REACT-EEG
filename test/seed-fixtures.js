// Real-data test fixtures. REACT EEG forbids synthetic signal data ANYWHERE, including tests,
// so every fixture is a real public-domain PhysioNet recording bundled under public/seed-edfs/
// (EEGMMIDB 64-ch @160 Hz + eegmat 23-ch @500 Hz — the same files the app seeds on first launch).
//
// The seeds are committed to the repo, so a fresh clone has them. If one is missing we fail
// LOUDLY with a restore hint rather than silently skipping — a suite that quietly stops
// exercising the DSP/EDF paths because a fixture vanished is worse than a red build.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEED_DIR = new URL("../public/seed-edfs/", import.meta.url);

/** Seed files available as fixtures (see public/seed-edfs/manifest.json). */
export const SEEDS = {
  eeg64:  "S001R01-eyes-open.edf",     // EEGMMIDB, 64-ch, 160 Hz, 61 × 1 s records
  eeg64b: "S001R02-eyes-closed.edf",
  mat23:  "MAT-S00-rest.edf",          // eegmat, 23-ch, 500 Hz, 60 × 1 s records
};

/**
 * Load a bundled seed EDF as an ArrayBuffer for use as a real test fixture.
 * @param {string} name — a file under public/seed-edfs/ (e.g. SEEDS.eeg64)
 * @returns {ArrayBuffer}
 * @throws with a clear restore hint if the seed is missing.
 */
export function loadSeedEdf(name) {
  let buf;
  try {
    buf = readFileSync(fileURLToPath(new URL(name, SEED_DIR)));
  } catch {
    throw new Error(
      `Missing seed EDF fixture "${name}" under public/seed-edfs/.\n` +
      `Tests use REAL PhysioNet recordings (no synthetic data allowed). These files are ` +
      `committed to the repo — restore them with:  git checkout -- public/seed-edfs/\n` +
      `(or re-fetch per the "Seed data" section of README.md).`);
  }
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
