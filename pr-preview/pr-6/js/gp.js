// Guitar Pro import: reads GP3/GP4/GP5/GPX/GP7/GP8 files with the vendored
// alphaTab importer and turns each drum track into a beat-domain chart model
// (see dtxwrite.js) in playback order, with repeats and jumps expanded.
//
// alphaTab's MIDI generator does the playback-order work: it is driven with a
// handler that captures notes and tempo changes per track, and its tick
// lookup gives the played sequence of measures.

let alphaTab = null;

function loadAlphaTab() {
  alphaTab ??= import('./vendor/alphatab/alphaTab.core.min.mjs');
  return alphaTab;
}

export const GP_EXTENSIONS = ['.gp', '.gp3', '.gp4', '.gp5', '.gpx'];

export function isGuitarProFile(name) {
  const n = name.toLowerCase();
  return GP_EXTENSIONS.some((ext) => n.endsWith(ext));
}

// General MIDI percussion key -> DTX drum channel.
export const GM_TO_CHANNEL = new Map([
  [35, 0x13], [36, 0x13],                             // kick
  [37, 0x12], [38, 0x12], [39, 0x12], [40, 0x12],     // side stick, snare, clap, electric snare
  [42, 0x11],                                         // closed hi-hat
  [46, 0x18],                                         // open hi-hat
  [44, 0x1B],                                         // pedal hi-hat
  [48, 0x14], [50, 0x14],                             // high toms
  [45, 0x15], [47, 0x15],                             // low / mid toms
  [41, 0x17], [43, 0x17],                             // floor toms
  [49, 0x16], [52, 0x16], [55, 0x16],                 // crash, china, splash
  [57, 0x1A],                                         // crash 2 -> left cymbal
  [51, 0x19], [53, 0x19], [59, 0x19],                 // ride, ride bell, ride 2
]);

const GM_NAMES = {
  54: 'Tambourine', 56: 'Cowbell', 58: 'Vibraslap', 60: 'Hi Bongo', 61: 'Low Bongo',
  62: 'Mute Hi Conga', 63: 'Open Hi Conga', 64: 'Low Conga', 65: 'High Timbale',
  66: 'Low Timbale', 67: 'High Agogo', 68: 'Low Agogo', 69: 'Cabasa', 70: 'Maracas',
  71: 'Short Whistle', 72: 'Long Whistle', 73: 'Short Guiro', 74: 'Long Guiro',
  75: 'Claves', 76: 'Hi Wood Block', 77: 'Low Wood Block', 78: 'Mute Cuica',
  79: 'Open Cuica', 80: 'Mute Triangle', 81: 'Open Triangle',
};

function keyName(key) {
  return GM_NAMES[key] || `key ${key}`;
}

const DEFAULT_DIVISION = 960;

// Last index i with sorted[i] <= v.
function floorIndex(sorted, v) {
  let lo = 0, hi = sorted.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// bytes: Uint8Array of a Guitar Pro file.
// Returns { title, artist, charts: [{ name, model, warnings: [string] }] }.
export async function convertGuitarPro(bytes) {
  const at = await loadAlphaTab();
  const { importer, midi, Settings, Logger, LogLevel } = at;
  Logger.logLevel = LogLevel.Warning;

  const settings = new Settings();
  let score;
  try {
    score = importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  } catch (err) {
    throw new Error(`Not a readable Guitar Pro file (${err?.message || err}).`);
  }

  const drumTracks = score.tracks.filter((t) => t.isPercussion || t.staves.some((s) => s.isPercussion));
  if (!drumTracks.length) throw new Error('This Guitar Pro file has no drum track.');

  // Muted or soloed tracks would otherwise be left out of the generated MIDI.
  for (const t of score.tracks) {
    t.playbackInfo.isMute = false;
    t.playbackInfo.isSolo = false;
  }

  const notesByTrack = new Map();
  const tempos = [];
  const noop = () => {};
  const handler = {
    addNote(track, start, length, key) {
      if (!notesByTrack.has(track)) notesByTrack.set(track, []);
      notesByTrack.get(track).push({ start: Math.round(start), key });
    },
    addTempo(tick, bpm) { tempos.push({ tick: Math.round(tick), bpm }); },
    addTimeSignature: noop, addRest: noop, addControlChange: noop, addProgramChange: noop,
    addNoteBend: noop, addBend: noop, finishTrack: noop, addTickShift: noop, addMetronome: noop,
  };
  const generator = new midi.MidiFileGenerator(score, settings, handler);
  generator.generate();

  // Played measures, in order: [start, end) in absolute ticks. Ticks are
  // rounded to whole values: files with an audio track carry sync-point
  // tempos that can put events between ticks (1 tick ≈ 0.5 ms at 120 BPM),
  // and the DTX grid needs integers.
  const played = generator.tickLookup.masterBars.map((m) => ({ start: Math.round(m.start), end: Math.round(m.end) }));
  if (!played.length) throw new Error('This Guitar Pro file has no measures.');
  const barStarts = played.map((m) => m.start);
  const division = midi.MidiUtils?.QuarterTime || DEFAULT_DIVISION;

  // Tempo events, relative to the played measures. Same-tick events keep the last.
  tempos.sort((a, b) => a.tick - b.tick);
  const tempoMap = [];
  for (const t of tempos) {
    const bar = Math.max(0, floorIndex(barStarts, t.tick));
    const tick = Math.max(0, t.tick - barStarts[bar]);
    if (tick >= played[bar].end - played[bar].start) continue; // after the last measure
    const prev = tempoMap[tempoMap.length - 1];
    if (prev && prev.bar === bar && prev.tick === tick) prev.bpm = t.bpm;
    else if (!prev || prev.bpm !== t.bpm) tempoMap.push({ bar, tick, bpm: t.bpm });
  }
  if (!tempoMap.length || tempoMap[0].bar !== 0 || tempoMap[0].tick !== 0) {
    tempoMap.unshift({ bar: 0, tick: 0, bpm: score.tempo || 120 });
  }

  const charts = drumTracks.map((track) => {
    const bars = played.map((m) => ({ ticks: m.end - m.start, notes: [] }));
    const skipped = new Map();
    let outside = 0;
    for (const n of notesByTrack.get(track.index) || []) {
      const ch = GM_TO_CHANNEL.get(n.key);
      if (!ch) {
        skipped.set(n.key, (skipped.get(n.key) || 0) + 1);
        continue;
      }
      const bar = floorIndex(barStarts, n.start);
      const tick = n.start - (bar >= 0 ? barStarts[bar] : 0);
      if (bar < 0 || tick >= bars[bar].ticks) { outside++; continue; }
      bars[bar].notes.push({ tick, ch });
    }

    const warnings = [];
    if (skipped.size) {
      const total = [...skipped.values()].reduce((a, b) => a + b, 0);
      const list = [...skipped].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${keyName(k)} ×${c}`).join(', ');
      warnings.push(`${total} note${total > 1 ? 's' : ''} with no drum lane were skipped (${list}).`);
    }
    if (outside) warnings.push(`${outside} note${outside > 1 ? 's' : ''} outside the measures were skipped.`);

    const noteCount = bars.reduce((a, b) => a + b.notes.length, 0);
    return {
      name: track.name || 'Drums',
      noteCount,
      warnings,
      model: {
        title: score.title || '',
        artist: score.artist || '',
        division,
        bars,
        tempos: tempoMap,
      },
    };
  });

  const playable = charts.filter((c) => c.noteCount > 0);
  if (!playable.length) {
    const why = charts.flatMap((c) => c.warnings.map((w) => (charts.length > 1 ? `${c.name}: ${w}` : w))).join('\n');
    throw new Error(why
      ? `None of the drum notes in this file fit a drum lane.\n${why}`
      : 'The drum tracks in this file have no notes.');
  }
  return { title: score.title || '', artist: score.artist || '', charts: playable };
}
